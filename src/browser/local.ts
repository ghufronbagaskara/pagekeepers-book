import { locale } from "./i18n";

export type Grant = { uid: string; expiresAt: number };
export type Book = { hash: string; title: string; bytes: number; pages?: number; path?: string; personal?: boolean; cover?: Blob };
export type Progress = { page: number; revision: number; mutation?: string; lastReadAt?: number; visitPending?: number };
const grantKey = "reader-session";

export function remember(grant?: Grant) {
  if (grant) localStorage.setItem(grantKey, JSON.stringify(grant));
  else localStorage.removeItem(grantKey);
}
export function lock(): never {
  remember();
  location.replace("/login/");
  throw new Error("SESSION");
}
export async function session(): Promise<Grant> {
  let response: Response | undefined;
  try { response = await fetch("/api/session/", { cache: "no-store" }); } catch {}
  if (response?.ok) {
    const grant: Grant = await response.json();
    remember(grant);
    return grant;
  }
  if (response?.status === 401) return lock();
  const saved: Grant | null = JSON.parse(localStorage.getItem(grantKey) ?? "null");
  if (!saved || saved.expiresAt <= Date.now()) return lock();
  return saved;
}
export function watchSession(grant: Grant) {
  let timer: ReturnType<typeof setTimeout>;
  const check = () => {
    clearTimeout(timer);
    const current: Grant | null = JSON.parse(localStorage.getItem(grantKey) ?? "null");
    if (current?.uid !== grant.uid) {
      location.replace("/login/");
      return;
    }
    const remaining = current.expiresAt - Date.now();
    if (remaining <= 0) {
      remember();
      location.replace("/login/");
      return;
    }
    timer = setTimeout(check, remaining);
  };
  check();
  window.addEventListener("storage", (event) => { if (event.key === grantKey || event.key === null) check(); });
  document.addEventListener("visibilitychange", () => {
    check();
    if (!document.hidden && navigator.onLine) void session().then(check).catch(() => {});
  });
  window.addEventListener("online", () => void session().then(check).catch(() => {}));
}
export const cacheShell = () => navigator.serviceWorker?.register("/sw.js");

type Store = "books" | "progress" | "catalog" | "sessions" | "bookmarks";
const stores: Store[] = ["books", "progress", "catalog", "sessions", "bookmarks"];
const database = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open("ruang-baca", 2);
  request.onupgradeneeded = () => {
    for (const name of stores) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
  };
  request.onsuccess = () => {
    // Let a newer version in another tab upgrade instead of waiting on this one.
    request.result.onversionchange = () => request.result.close();
    resolve(request.result);
  };
  request.onerror = () => reject(request.error);
});
export async function operation<T>(store: Store, mode: IDBTransactionMode, run: (table: IDBObjectStore) => IDBRequest<T>) {
  const db = await database;
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const result = run(tx.objectStore(store));
    tx.oncomplete = () => resolve(result.result);
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}
export const get = <T>(store: Store, key: string) => operation<T>(store, "readonly", (table) => table.get(key));
export const put = <T>(store: Store, key: string, value: T) => operation(store, "readwrite", (table) => table.put(value, key));
export const remove = (store: Store, key: string) => operation(store, "readwrite", (table) => table.delete(key));
export const bookKey = (uid: string, hash: string) => `${uid}/${hash}`;
export const all = <T>(store: Store, uid: string) =>
  operation<T[]>(store, "readonly", (table) => table.getAll(IDBKeyRange.bound(`${uid}/`, `${uid}/\uffff`)));
export const savedBooks = (uid: string) => all<Book>("books", uid);
async function directory(uid: string) {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(uid);
}
export async function localFile(uid: string, path: string) {
  return (await (await directory(uid)).getFileHandle(path)).getFile();
}
export async function deleteFile(uid: string, path: string) {
  try { await (await directory(uid)).removeEntry(path); }
  catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
}
export function humanBytes(bytes: number) {
  return `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(bytes / 1048576)} MB`;
}
