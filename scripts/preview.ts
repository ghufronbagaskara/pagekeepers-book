import { wrangler } from "./admin";
wrangler(["d1", "migrations", "apply", "ruang-baca-local", "--local"], true);
wrangler(["dev", "--local", "--ip", "127.0.0.1", "--port", "4321"], true);
