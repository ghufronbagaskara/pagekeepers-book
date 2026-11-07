import { all, lock, operation, put } from "./local";
import { dayKey, type Timed } from "./stats";

export type Session = Timed & { id: string; hash: string; pageStart: number; pageEnd: number; dirty?: boolean };

const IDLE_MS = 5 * 60_000; // ponytail: fixed idle cutoff; make it a setting if slow pages get undercounted
const SPLIT_MS = 30 * 60_000;
const MIN_MS = 10_000;
const key = (uid: string, id: string) => `${uid}/${id}`;

/**
 * Measures reading time from timestamps, so throttled or frozen timers cannot inflate it.
 * `visibleMs` (book on screen) drives the timer; the session's `activeMs` also stops after IDLE_MS without input.
 */
export class ReadingClock {
  session?: Session;
  visibleMs = 0;
  onTick?: () => void;
  private lastTick = Date.now();
  private lastInput = Date.now();

  constructor(private readonly uid: string, private readonly hash: string, private readonly page: () => number) {
    for (const name of ["pointerdown", "pointermove", "wheel", "keydown"]) addEventListener(name, () => this.touch(), { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return void this.save().then(() => syncSessions(uid));
      this.lastTick = Date.now();
      this.touch();
    });
    addEventListener("pagehide", () => void this.save());
    setInterval(() => this.tick(), 1000);
  }

  touch() {
    const now = Date.now();
    if (now - this.lastInput > SPLIT_MS) this.session = undefined;
    this.lastInput = now;
  }

  private tick() {
    const now = Date.now();
    // ponytail: gaps over 5 s (sleep, frozen tab) are dropped rather than guessed at.
    const delta = now - this.lastTick > 5000 ? 0 : Math.max(0, now - this.lastTick);
    this.lastTick = now;
    if (document.hidden || !delta) return;
    this.visibleMs += delta;
    if (now - this.lastInput <= IDLE_MS) {
      const page = this.page();
      this.session ??= { id: crypto.randomUUID(), hash: this.hash, startedAt: now, activeMs: 0, pageStart: page, pageEnd: page };
      this.session.activeMs += delta;
      this.session.pageEnd = page;
    }
    this.onTick?.();
  }

  async save() {
    if (this.session && this.session.activeMs >= MIN_MS) {
      await put("sessions", key(this.uid, this.session.id), { ...this.session, dirty: true });
    }
  }
}

const markSent = (uid: string, sent: Session) => operation("sessions", "readwrite", (table) => {
  const request = table.get(key(uid, sent.id));
  request.onsuccess = () => {
    const stored = request.result as Session | undefined;
    if (stored && stored.activeMs === sent.activeMs) table.put({ ...stored, dirty: false }, key(uid, sent.id));
  };
  return request;
});

let pushing: Promise<void> | undefined;
export function syncSessions(uid: string) {
  if (!navigator.onLine) return Promise.resolve();
  pushing ??= (async () => {
    const dirty = (await all<Session>("sessions", uid)).filter((item) => item.dirty);
    // The API reads at most 4 KiB per request, which fits a dozen sessions.
    for (let offset = 0; offset < dirty.length; offset += 12) {
      const batch = dirty.slice(offset, offset + 12).map(({ dirty: _, ...item }) => item);
      const response = await fetch("/api/sessions/", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessions: batch }),
      });
      if (response.status === 401) return lock();
      // A rejected batch would be rejected forever, so it is dropped from the queue rather than retried.
      if (!response.ok && response.status !== 400) return;
      for (const item of batch) await markSent(uid, item);
    }
  })().catch(() => {}).finally(() => { pushing = undefined; });
  return pushing;
}

/** Local sessions merged with every device's sessions from the last 400 days. */
export async function loadSessions(uid: string) {
  const response = navigator.onLine
    ? await fetch(`/api/sessions/?since=${Date.now() - 400 * 86_400_000}`).catch(() => undefined)
    : undefined;
  if (response?.status === 401) lock();
  if (response?.ok) {
    for (const remote of await response.json() as Session[]) {
      await operation("sessions", "readwrite", (table) => {
        const request = table.get(key(uid, remote.id));
        request.onsuccess = () => {
          const stored = request.result as Session | undefined;
          if (!stored || stored.activeMs < remote.activeMs) table.put({ ...remote, dirty: false }, key(uid, remote.id));
        };
        return request;
      });
    }
  }
  void syncSessions(uid);
  return all<Session>("sessions", uid);
}

export async function todayMs(uid: string) {
  const today = dayKey(Date.now());
  return (await all<Session>("sessions", uid)).filter((item) => dayKey(item.startedAt) === today)
    .reduce((total, item) => total + item.activeMs, 0);
}
