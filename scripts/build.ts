import { resolve } from "node:path";
import * as Astro from "@alchemy.run/frontend-frameworks/astro";
import cloudflare from "@alchemy.run/frontend-frameworks/astro/cloudflare";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

process.env.XDG_STATE_HOME ??= resolve(".alchemy-state");
process.env.ASTRO_TELEMETRY_DISABLED ??= "1";

const program = Effect.gen(function* () {
  const framework = yield* Astro.make({
    target: cloudflare({
      worker: { compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"], worker: { name: "ruang-baca-preview", bindings: [] } },
      sessions: false,
    }),
    astro: { output: "server", trailingSlash: "always" },
  });
  yield* framework.build();
});

await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)));
process.exit(0);
