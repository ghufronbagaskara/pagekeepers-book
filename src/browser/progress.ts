import { bookKey, get, lock, put, type Progress } from "./local";

export class ReadingProgress {
  private writing = Promise.resolve();
  private pending?: Promise<void>;
  private paused = false;
  private readonly key: string;
  current: Progress = { page: 1, revision: 0 };

  constructor(uid: string, private readonly hash: string, private readonly conflict: (local: number, cloud: number) => Promise<boolean>) {
    this.key = bookKey(uid, hash);
  }

  async open() {
    this.current = await get<Progress>("progress", this.key) ?? this.current;
    if (!navigator.onLine) return this.current.page;
    if (this.current.mutation) await this.sync().catch(() => {});
    else await this.refresh().catch(() => {});
    return this.current.page;
  }

  async refresh() {
    if (this.current.mutation || this.paused) return;
    const response = await fetch(`/api/progress/${this.hash}/`);
    if (response.status === 401) return lock();
    if (!response.ok || this.current.mutation) return;
    const remote: Progress = await response.json();
    if (this.current.mutation || remote.revision < this.current.revision) return;
    this.current = {
      ...this.current, page: remote.page, revision: remote.revision,
      lastReadAt: Math.max(this.current.lastReadAt ?? 0, remote.lastReadAt ?? 0),
    };
    await this.persist();
  }

  save(page: number) {
    if (page === this.current.page) return this.writing;
    this.current = { ...this.current, page, lastReadAt: Date.now(), mutation: crypto.randomUUID() };
    return this.persist();
  }

  visit() {
    const now = Date.now();
    this.current = { ...this.current, lastReadAt: now, visitPending: now };
    return this.persist();
  }

  private persist() {
    const snapshot = this.current;
    this.writing = this.writing.catch(() => {}).then(async () => { await put("progress", this.key, snapshot); });
    return this.writing;
  }

  sync() {
    if (!this.pending && navigator.onLine) {
      this.pending = this.push().finally(() => { this.pending = undefined; });
    }
    return this.pending ?? Promise.resolve();
  }

  private async syncVisit() {
    const visit = this.current.visitPending;
    if (!visit) return;
    await this.writing;
    const response = await fetch(`/api/progress/${this.hash}/`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lastReadAt: visit }),
    });
    if (response.status === 401) return lock();
    if (response.ok && this.current.visitPending === visit) {
      this.current = { ...this.current, visitPending: undefined };
      await this.persist();
    }
  }

  private async push() {
    await this.syncVisit();
    while (this.current.mutation) {
      const sent = this.current;
      await this.writing;
      const response = await fetch(`/api/progress/${this.hash}/`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sent),
      });
      if (response.status === 401) return lock();
      if (!response.ok && response.status !== 409) return;
      const remote: Progress = await response.json();
      if (response.status === 409 && this.current.page !== remote.page) {
        this.paused = true;
        let keepLocal: boolean;
        try { keepLocal = await this.conflict(this.current.page, remote.page); }
        finally { this.paused = false; }
        this.current = keepLocal ? { ...this.current, revision: remote.revision, mutation: crypto.randomUUID() } :
          { ...this.current, page: remote.page, revision: remote.revision, mutation: undefined };
      } else {
        const newer = this.current.mutation !== sent.mutation && this.current.page !== remote.page;
        this.current = newer ? { ...this.current, revision: remote.revision } :
          { ...this.current, page: remote.page, revision: remote.revision, mutation: undefined };
      }
      await this.persist();
    }
  }
}
