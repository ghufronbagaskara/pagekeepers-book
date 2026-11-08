import { randomUUID } from "node:crypto";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { execute, sql, target, wrangler } from "./admin";

const stage = target(process.argv[2]);
const action = process.argv[3];
const value = process.argv[4]?.trim();
const validId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);
if (action === "create" && value) {
  const email = value.toLowerCase();
  const legacyId = process.argv[5]?.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
  if (legacyId && !validId(legacyId)) throw new Error("The existing account ID is invalid.");
  const uid = legacyId ?? randomUUID();
  const password = process.env.PAGEKEEPERS_NEW_PASSWORD;
  delete process.env.PAGEKEEPERS_NEW_PASSWORD;
  if (!password || password.length < 12 || password.length > 128) {
    throw new Error("Set PAGEKEEPERS_NEW_PASSWORD to a password with 12 to 128 characters.");
  }
  const hash = await hashPassword(password);
  const id = sql(uid);
  const now = sql(new Date().toISOString());
  const directory = await mkdtemp(join(tmpdir(), "pagekeepers-"));
  const file = join(directory, "account.sql");
  try {
    await writeFile(file, `
      INSERT INTO accounts(uid) VALUES (${id}) ON CONFLICT(uid) DO NOTHING;
      INSERT INTO auth_user(id, name, email, emailVerified, createdAt, updatedAt)
      VALUES (${id}, ${sql(email)}, ${sql(email)}, 0, ${now}, ${now});
      INSERT INTO auth_account(id, accountId, providerId, userId, password, createdAt, updatedAt)
      VALUES (${sql(randomUUID())}, ${id}, 'credential', ${id}, ${sql(hash)}, ${now}, ${now});
    `, { mode: 0o600 });
    wrangler(["d1", "execute", stage.name, stage.local ? "--local" : "--remote", "--file", file, "--yes"], stage.local);
  } finally {
    await unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
  console.log(`Created reader account: ${uid}`);
} else if (action === "role" && value && ["admin", "user"].includes(process.argv[5] ?? "")) {
  // Accepts an email or an account ID, so the first admin can be promoted right after `create`.
  const who = sql(value.toLowerCase().includes("@") ? value.toLowerCase() : value);
  execute(stage, `UPDATE accounts SET role=${sql(process.argv[5]!)} WHERE uid=${who} OR uid IN (SELECT id FROM auth_user WHERE email=${who});`);
} else if (value && validId(value) && ["disable", "enable", "revoke"].includes(action ?? "")) {
  const id = sql(value);
  const statements = [];
  if (action !== "revoke") statements.push(`UPDATE accounts SET active=${action === "enable" ? 1 : 0} WHERE uid=${id};`);
  if (action !== "enable") statements.push(`DELETE FROM auth_session WHERE userId=${id};`, `DELETE FROM sessions WHERE uid=${id};`);
  execute(stage, statements.join("\n"));
} else {
  throw new Error("Usage: bun run account <local|staging|prod> create <email> [existing-account-id], or <disable|enable|revoke> <account-id>, or role <email|account-id> <admin|user>");
}
