import { bookKey, get, lock, put } from "./local";

export type Mark = { page: number; note: string; updatedAt: number; deleted: boolean; dirty?: boolean };
type RemoteMark = Omit<Mark, "deleted" | "dirty"> & { deleted: number | boolean };
const clean = (mark: RemoteMark): Mark => ({ page: mark.page, note: mark.note, updatedAt: mark.updatedAt, deleted: Boolean(mark.deleted) });

/** Bookmarks for one book: written locally first, then pushed page by page, newest write winning. */
export class Bookmarks {
  marks: Mark[] = [];
  onChange?: () => void;
  private pending?: Promise<void>;
  private readonly key: string;

  constructor(uid: string, private readonly hash: string) {
    this.key = bookKey(uid, hash);
  }

  get visible() {
    return this.marks.filter((mark) => !mark.deleted).sort((a, b) => a.page - b.page);
  }
  find(page: number) {
    return this.visible.find((mark) => mark.page === page);
  }

  async open() {
    this.marks = await get<Mark[]>("bookmarks", this.key) ?? [];
    this.onChange?.();
    if (!navigator.onLine) return;
    const response = await fetch(`/api/bookmarks/${this.hash}/`).catch(() => undefined);
    if (response?.status === 401) lock();
    if (response?.ok) {
      for (const remote of await response.json() as RemoteMark[]) this.adopt(clean(remote));
      await this.persist();
    }
    await this.sync();
  }

  set(page: number, note: string, deleted = false) {
    this.replace({ page, note: note.trim().slice(0, 500), deleted, updatedAt: Date.now(), dirty: true });
    return this.persist().then(() => this.sync());
  }

  sync() {
    if (!navigator.onLine) return Promise.resolve();
    this.pending ??= (async () => {
      for (const sent of this.marks.filter((mark) => mark.dirty)) {
        const { dirty: _, ...body } = sent;
        const response = await fetch(`/api/bookmarks/${this.hash}/`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        if (response.status === 401) return lock();
        if (!response.ok && response.status !== 400) return;
        const local = this.marks.find((mark) => mark.page === sent.page);
        if (local?.updatedAt !== sent.updatedAt) continue;
        this.replace(response.ok ? clean(await response.json()) : { ...local, dirty: false });
        await this.persist();
      }
    })().catch(() => {}).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private adopt(remote: Mark) {
    const local = this.marks.find((mark) => mark.page === remote.page);
    if (!local || remote.updatedAt > local.updatedAt || (!local.dirty && remote.updatedAt === local.updatedAt)) this.replace(remote);
  }
  private replace(mark: Mark) {
    this.marks = [...this.marks.filter((item) => item.page !== mark.page), mark];
    this.onChange?.();
  }
  private persist() {
    return put("bookmarks", this.key, this.marks);
  }
}
