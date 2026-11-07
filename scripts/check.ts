process.env.ASTRO_TELEMETRY_DISABLED ??= "1";
const result = Bun.spawnSync(["bun", "node_modules/astro/bin/astro.mjs", "check"], { stdout: "inherit", stderr: "inherit", stdin: "inherit", env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" } });
process.exit(result.exitCode ?? 1);
