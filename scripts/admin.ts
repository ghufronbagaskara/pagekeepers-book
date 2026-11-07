import { resolve, join } from "node:path";
import os from "node:os";
import fs from "node:fs";

const popplerPath = "C:\\Users\\ghufr\\AppData\\Local\\Microsoft\\WinGet\\Packages\\oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe\\poppler-25.07.0\\Library\\bin";
if (fs.existsSync(popplerPath) && !process.env.PATH?.includes(popplerPath)) {
  process.env.PATH = `${popplerPath};${process.env.PATH ?? ""}`;
}

export function ensureCloudflareCredentials() {
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    try {
      const credPath = join(os.homedir(), ".alchemy", "profiles", "default", "cloudflare.json");
      if (fs.existsSync(credPath)) {
        const cred = JSON.parse(fs.readFileSync(credPath, "utf8"));
        if (cred?.values?.access) {
          process.env.CLOUDFLARE_API_TOKEN ??= cred.values.access;
        }
        if (cred?.values?.accountId) {
          process.env.CLOUDFLARE_ACCOUNT_ID ??= cred.values.accountId;
        }
      }
    } catch {}
  }
}

export function run(command: string[], options?: { capture?: boolean }) {
  const result = Bun.spawnSync(command, {
    stdout: options?.capture ? "pipe" : "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: { ...process.env },
  });
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed with status ${result.exitCode}`);
  return options?.capture ? new TextDecoder().decode(result.stdout) : "";
}

export function wrangler(args: string[], local: boolean) {
  if (!local) ensureCloudflareCredentials();
  process.env.WRANGLER_LOG_PATH ??= resolve(".wrangler/reader.log");
  process.env.WRANGLER_REGISTRY_PATH ??= resolve(".wrangler/registry");
  process.env.WRANGLER_SEND_METRICS ??= "false";
  return run(["node", "node_modules/wrangler/bin/wrangler.js", ...args, ...(local ? ["--config", "wrangler.preview.json"] : [])]);
}
export function sql(value: string) {
  if (value.includes("\0")) throw new Error("NUL is not allowed in SQL values");
  return "'" + value.replaceAll("'", "''") + "'";
}
export function target(stage: string | undefined) {
  if (!stage || !["local", "staging", "prod"].includes(stage)) throw new Error("Specify local, staging, or prod");
  return { local: stage === "local", name: `ruang-baca-${stage}` };
}
export function execute(stage: ReturnType<typeof target>, statement: string) {
  return wrangler(["d1", "execute", stage.name, stage.local ? "--local" : "--remote", "--command", statement], stage.local);
}
