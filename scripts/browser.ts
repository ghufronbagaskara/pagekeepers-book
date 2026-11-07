import { readdir, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

await mkdir("public/client", { recursive: true });
const result = await Bun.build({
  entrypoints: ["login", "library", "reader", "storage-worker"].map((name) => `src/browser/${name}.ts`),
  target: "browser", outdir: "public/client", minify: true, format: "esm",
});
if (!result.success) throw new AggregateError(result.logs, "Failed to build browser modules");

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }));
  return paths.flat();
}
const assets = (await files("public/zaya")).filter((path) => !/\.(md|txt)$|LICENSE$/i.test(path))
  .concat((await files("public/client")).filter((path) => path.endsWith(".js")), ["public/site.css"]);
const digest = createHash("sha256");
for (const path of assets.sort()) digest.update(await readFile(path));
const template = await readFile("src/browser/sw.js", "utf8");
digest.update(template);
for (const path of [...await files("src/pages"), ...await files("src/layouts")].filter((path) => path.endsWith(".astro")).sort()) {
  digest.update(await readFile(path));
}
const urls = assets.map((path) => "/" + path.replaceAll("\\", "/").replace(/^public\//, ""));
await writeFile("public/sw.js", template.replace('"__VERSION__"', JSON.stringify(digest.digest("hex").slice(0, 16)))
  .replace('"__ASSETS__"', JSON.stringify(urls)));
