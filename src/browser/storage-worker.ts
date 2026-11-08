import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

type Job = { uid: string; file?: File; hash?: string; bytes: number };
type SyncHandle = { write(bytes: Uint8Array, options: { at: number }): number; flush(): void; close(): void };
const controller = new AbortController();

self.onmessage = async ({ data }: MessageEvent<Job | "cancel">) => {
  if (data === "cancel") {
    controller.abort();
    return;
  }
  const { uid, file, hash, bytes } = data;
  const temp = `book-${crypto.randomUUID()}`;
  let directory: FileSystemDirectoryHandle | undefined;
  let writer: SyncHandle | undefined;
  let kept = false;
  try {
    const root = await navigator.storage.getDirectory();
    directory = await root.getDirectoryHandle(uid, { create: true });
    const handle = await directory.getFileHandle(temp, { create: true });
    writer = await (handle as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
    let stream = file?.stream();
    if (!stream) {
      const response = await fetch(`/api/pdf/${hash}/`, { signal: controller.signal });
      if (response.status === 401) throw new Error("SESSION");
      if (!response.ok || !response.body) throw new Error("The download failed. Try again.");
      stream = response.body;
    }
    const reader = stream.getReader();
    const cancelRead = () => void reader.cancel().catch(() => {});
    controller.signal.addEventListener("abort", cancelRead, { once: true });
    const digest = sha256.create();
    let offset = 0;
    let reported = 0;
    let magic = "";
    try {
      while (true) {
        controller.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.length > bytes) throw new Error("The PDF size does not match the library record.");
        if (magic.length < 5) magic += new TextDecoder().decode(value.subarray(0, 5 - magic.length));
        digest.update(value);
        const written = writer.write(value as Uint8Array<ArrayBuffer>, { at: offset });
        if (written !== value.length) throw new Error("There is not enough space on this device.");
        offset += written;
        if (offset - reported >= 512 * 1024) {
          reported = offset;
          self.postMessage({ loaded: offset });
        }
      }
    } finally {
      controller.signal.removeEventListener("abort", cancelRead);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    controller.signal.throwIfAborted();
    const actual = bytesToHex(digest.digest());
    if (offset !== bytes || (hash && actual !== hash)) throw new Error("The download is incomplete or damaged. Try again.");
    if (magic !== "%PDF-") throw new Error("This file does not appear to be a valid PDF.");
    writer.flush();
    writer.close();
    writer = undefined;
    kept = true;
    self.postMessage({ hash: actual, path: temp });
  } catch (error) {
    writer?.close();
    if (!kept && directory) await directory.removeEntry(temp).catch(() => {});
    self.postMessage({ error: controller.signal.aborted ? "Download canceled." :
      error instanceof DOMException && error.name === "QuotaExceededError" ? "There is not enough space on this device." :
      error instanceof Error ? error.message : "The book could not be saved on this device." });
  }
};
