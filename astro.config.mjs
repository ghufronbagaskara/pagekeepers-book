import { execFileSync } from "node:child_process";
import { defineConfig } from "astro/config";

export default defineConfig({
  trailingSlash: "always",
  integrations: [{
    name: "reader-browser",
    hooks: {
      "astro:config:setup": () => execFileSync("bun", ["scripts/browser.ts"], { stdio: "inherit" }),
    },
  }],
});
