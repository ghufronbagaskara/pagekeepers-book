import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "ruang-baca",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    if (!["staging", "prod"].includes(stage)) throw new Error("Use --stage staging or --stage prod");
    const name = `ruang-baca-${stage}`;
    const secret = yield* Alchemy.makeRandom("ReaderSessionSecret");
    const db = Cloudflare.D1.Database("ReaderDB", { name, migrations: "./migrations" });
    const files = Cloudflare.R2.Bucket("ReaderPDFs", { name, storageClass: "Standard" });
    const site = yield* Cloudflare.Website.Astro("Website", {
      name,
      astro: { output: "server", trailingSlash: "always" },
      assets: { notFoundHandling: "404-page", htmlHandling: "auto-trailing-slash" },
      sessionKVBindingName: false,
      observability: { enabled: true },
      env: {
        DB: db,
        FILES: files,
        BETTER_AUTH_SECRET: secret,
        AUTH_THROTTLE: Cloudflare.RateLimit("ReaderLogin", { namespaceId: 1071, simple: { limit: 10, period: 60 } }),
      },
    });
    return { url: site.url, bucket: name, database: name };
  }),
);
