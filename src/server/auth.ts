import { betterAuth } from "better-auth";
import type { D1Database } from "@cloudflare/workers-types";

export const sessionLifetime = 7 * 24 * 60 * 60;

export function createAuth(database: D1Database, secret: string, origin: string) {
  return betterAuth({
    database,
    secret,
    baseURL: origin,
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128 },
    advanced: { useSecureCookies: true },
    user: { modelName: "auth_user" },
    account: { modelName: "auth_account" },
    verification: { modelName: "auth_verification" },
    session: {
      modelName: "auth_session",
      expiresIn: sessionLifetime,
      disableSessionRefresh: true,
    },
  });
}
