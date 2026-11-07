import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execute, run, sql, target, wrangler } from "./admin";

const stage = target(process.argv[2]);
const supplied = process.argv.slice(3);
const files = (supplied.length ? supplied : (await readdir("book")).map((file) => join("book", file)))
  .filter((file) => extname(file).toLowerCase() === ".pdf");
if (!files.length) throw new Error("No PDFs supplied");
const useS3 = !stage.local && Boolean(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
const r2 = useS3 ? new Bun.S3Client({
  bucket: stage.name,
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
}) : undefined;

async function upload(path: string, key: string, type: string) {
  if (!r2) {
    wrangler(["r2", "object", "put", `${stage.name}/${key}`, ...(stage.local ? ["--local"] : ["--remote"]), "--file", path, "--content-type", type], stage.local);
    return;
  }
  const input = Bun.file(path);
  const object = r2.file(key);
  const writer = object.writer({ type, partSize: 8 * 1024 * 1024, queueSize: 2 });
  try {
    for await (const chunk of input.stream()) await writer.write(chunk);
    await writer.end();
  } catch (error) {
    try { await writer.end(error instanceof Error ? error : new Error("Upload failed")); } catch {}
    throw error;
  }
  if ((await object.stat()).size !== input.size) throw new Error(`R2 size mismatch for ${key}`);
  const expected = await checksum(path);
  const remote = createHash("sha256");
  for await (const chunk of object.stream()) remote.update(chunk);
  if (remote.digest("hex") !== expected) throw new Error(`R2 checksum mismatch for ${key}`);
}
async function checksum(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const temp = await mkdtemp(join(tmpdir(), "reader-cover-"));
try {
  for (const relative of files) {
    const path = resolve(relative);
    const bytes = (await stat(path)).size;
    const metadata = run(["pdfinfo", path], { capture: true });
    const pages = Number(metadata.match(/^Pages:\s+(\d+)\s*$/m)?.[1]);
    if (!bytes || !pages) throw new Error(`Invalid PDF: ${relative}`);
    const title = basename(path, extname(path));
    const hash = await checksum(path);
    const cover = join(temp, hash);
    run(["pdftoppm", "-f", "1", "-l", "1", "-scale-to", "440", "-jpeg", "-singlefile", path, cover]);
    await upload(path, hash + ".pdf", "application/pdf");
    await upload(cover + ".jpg", hash + ".jpg", "image/jpeg");
    execute(stage, `INSERT INTO books(hash,title,bytes,pages) VALUES(${sql(hash)},${sql(title)},${bytes},${pages})
      ON CONFLICT(hash) DO UPDATE SET title=excluded.title, bytes=excluded.bytes, pages=excluded.pages;`);
    console.log(`Published ${title} · ${pages} pages · ${bytes} bytes · ${hash}`);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
