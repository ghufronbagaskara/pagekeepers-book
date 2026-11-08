import type { D1Database } from "@cloudflare/workers-types";
import { hashPassword } from "better-auth/crypto";
import { body, fail, json } from "./http";

export type Role = "user" | "admin";
type Env = { DB: D1Database };
type Actor = { uid: string | null; email: string | null };

const uidPattern = /^[A-Za-z0-9_-]{1,128}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const retentionMs = 180 * 86_400_000;
const pageSize = 50;
const validPassword = (value: unknown): value is string => typeof value === "string" && value.length >= 12 && value.length <= 128;

/** One audit row, as a statement so it can share a batch with the change it records. */
export function auditEntry(env: Env, request: Request, actor: Actor, action: string, target: string | null = null, detail = "") {
  return env.DB.prepare("INSERT INTO audit_log(at, actor, actor_email, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(Date.now(), actor.uid, actor.email?.slice(0, 254) ?? null, action, target, detail.slice(0, 500),
      request.headers.get("CF-Connecting-IP") ?? null);
}
/** Record an event and drop entries past the retention window. */
export async function audit(env: Env, request: Request, actor: Actor, action: string, target: string | null = null, detail = "") {
  // ponytail: prune on every write; the index on `at` keeps it cheap. Move to a cron trigger if sign-ins get busy.
  await env.DB.batch([
    auditEntry(env, request, actor, action, target, detail),
    env.DB.prepare("DELETE FROM audit_log WHERE at < ?").bind(Date.now() - retentionMs),
  ]);
}

const userRow = `
  SELECT a.uid, a.active, a.role, u.email, u.name, u.createdAt,
    (SELECT MAX(p.last_read_at) FROM progress p WHERE p.uid = a.uid) AS lastReadAt,
    (SELECT COUNT(*) FROM auth_session s WHERE s.userId = a.uid AND s.expiresAt > ?1) +
    (SELECT COUNT(*) FROM sessions s WHERE s.uid = a.uid AND s.expires_at > ?2) AS sessions
  FROM accounts a LEFT JOIN auth_user u ON u.id = a.uid`;
const userBinds = () => [new Date().toISOString(), Date.now()] as const;

export async function admin(request: Request, path: string, env: Env, session: { uid: string; role: Role }) {
  if (session.role !== "admin") return fail(403, "Only admins can open this page.");
  const method = request.method;
  const email = await env.DB.prepare("SELECT email FROM auth_user WHERE id = ?").bind(session.uid).first<string>("email");
  const actor: Actor = { uid: session.uid, email };

  if (path === "overview" && method === "GET") {
    const [users, books, minutes, recent] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(active), 0) AS active, COALESCE(SUM(role = 'admin'), 0) AS admins FROM accounts").first(),
      env.DB.prepare("SELECT COUNT(*) AS total FROM books").first<number>("total"),
      env.DB.prepare("SELECT COALESCE(SUM(active_ms), 0) AS ms FROM reading_sessions WHERE started_at >= ?")
        .bind(Date.now() - 7 * 86_400_000).first<number>("ms"),
      env.DB.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 8").all(),
    ]);
    return json({ users, books, readingMinutes: Math.round((minutes ?? 0) / 60_000), recent: recent.results });
  }

  if (path === "audit" && method === "GET") {
    const params = new URL(request.url).searchParams;
    const kind = params.get("kind");
    const before = Number(params.get("before"));
    const rows = (await env.DB.prepare(`
      SELECT * FROM audit_log WHERE (?1 = '' OR action LIKE ?1 || '.%') AND (?2 = 0 OR id < ?2)
      ORDER BY id DESC LIMIT ?3
    `).bind(kind === "login" || kind === "user" ? kind : "", Number.isSafeInteger(before) && before > 0 ? before : 0, pageSize + 1).all()).results;
    return json({ entries: rows.slice(0, pageSize), more: rows.length > pageSize });
  }

  if (path === "users" && method === "GET") {
    // ponytail: one unpaged list; a private library has a handful of readers. Page it past a few hundred.
    return json((await env.DB.prepare(`${userRow} ORDER BY u.email COLLATE NOCASE, a.uid`).bind(...userBinds()).all()).results);
  }

  if (path === "users" && method === "POST") {
    const input = await body(request);
    const address = typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
    const name = typeof input?.name === "string" && input.name.trim() ? input.name.trim().slice(0, 100) : address;
    const role = input?.role === "admin" ? "admin" : "user";
    if (address.length > 254 || !emailPattern.test(address)) return fail(400, "Enter a valid email address.");
    if (!validPassword(input?.password)) return fail(400, "Use a password of 12 to 128 characters.");
    if (await env.DB.prepare("SELECT 1 FROM auth_user WHERE email = ?").bind(address).first()) {
      return fail(409, "That email already has an account.");
    }
    const uid = crypto.randomUUID();
    const now = new Date().toISOString();
    const hash = await hashPassword(input.password);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts(uid, role) VALUES (?, ?)").bind(uid, role),
      env.DB.prepare("INSERT INTO auth_user(id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)")
        .bind(uid, name, address, now, now),
      env.DB.prepare("INSERT INTO auth_account(id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), uid, uid, hash, now, now),
      auditEntry(env, request, actor, "user.create", uid, `${address} (${role})`),
    ]);
    return json(await env.DB.prepare(`${userRow} WHERE a.uid = ?3`).bind(...userBinds(), uid).first(), 201);
  }

  const [kind, uid, extra, rest] = path.split("/");
  if (kind !== "users" || !uidPattern.test(uid ?? "") || rest !== undefined) return fail(404, "Not found.");
  const target = await env.DB.prepare(`${userRow} WHERE a.uid = ?3`).bind(...userBinds(), uid!)
    .first<{ uid: string; email: string | null; role: Role; active: number }>();
  if (!target) return fail(404, "This account could not be found.");
  // The acting admin always stays an active admin, so the site can never lose its last one.
  if (target.uid === session.uid) return fail(400, "You can't change your own account from the admin page.");
  const label = target.email ?? target.uid;
  const endSessions = [
    env.DB.prepare("DELETE FROM auth_session WHERE userId = ?").bind(target.uid),
    env.DB.prepare("DELETE FROM sessions WHERE uid = ?").bind(target.uid),
  ];
  const updated = async () => json(await env.DB.prepare(`${userRow} WHERE a.uid = ?3`).bind(...userBinds(), target.uid).first());

  if (extra === undefined && method === "PATCH") {
    const input = await body(request) ?? {};
    const { active, role } = input;
    if ((active !== undefined && typeof active !== "boolean") || (role !== undefined && role !== "user" && role !== "admin") ||
        (active === undefined && role === undefined)) {
      return fail(400, "The change is invalid.");
    }
    const statements = [];
    if (typeof active === "boolean" && active !== (target.active === 1)) {
      statements.push(env.DB.prepare("UPDATE accounts SET active = ? WHERE uid = ?").bind(active ? 1 : 0, target.uid),
        auditEntry(env, request, actor, active ? "user.enable" : "user.disable", target.uid, label));
      if (!active) statements.push(...endSessions);
    }
    if (role && role !== target.role) {
      statements.push(env.DB.prepare("UPDATE accounts SET role = ? WHERE uid = ?").bind(role, target.uid),
        auditEntry(env, request, actor, "user.role", target.uid, `${label} → ${role}`));
    }
    if (statements.length) await env.DB.batch(statements);
    return updated();
  }
  if (extra === "password" && method === "PUT") {
    const password = (await body(request))?.password;
    if (!validPassword(password)) return fail(400, "Use a password of 12 to 128 characters.");
    if (!await env.DB.prepare("SELECT 1 FROM auth_account WHERE userId = ? AND providerId = 'credential'").bind(target.uid).first()) {
      return fail(404, "This account has no password sign-in.");
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE auth_account SET password = ?, updatedAt = ? WHERE userId = ? AND providerId = 'credential'")
        .bind(await hashPassword(password), new Date().toISOString(), target.uid),
      ...endSessions,
      auditEntry(env, request, actor, "user.password", target.uid, label),
    ]);
    return updated();
  }
  if (extra === "revoke" && method === "POST") {
    await env.DB.batch([...endSessions, auditEntry(env, request, actor, "user.revoke", target.uid, label)]);
    return updated();
  }
  if (extra === undefined && method === "DELETE") {
    const confirm = (await body(request))?.confirm;
    if (typeof confirm !== "string" || confirm.trim().toLowerCase() !== label.toLowerCase()) {
      return fail(400, "Type the account's email to confirm.");
    }
    await env.DB.batch([
      ...["bookmarks", "reading_sessions", "progress", "sessions"].map((table) =>
        env.DB.prepare(`DELETE FROM ${table} WHERE uid = ?`).bind(target.uid)),
      env.DB.prepare("DELETE FROM auth_session WHERE userId = ?").bind(target.uid),
      env.DB.prepare("DELETE FROM auth_account WHERE userId = ?").bind(target.uid),
      env.DB.prepare("DELETE FROM auth_user WHERE id = ?").bind(target.uid),
      env.DB.prepare("DELETE FROM accounts WHERE uid = ?").bind(target.uid),
      auditEntry(env, request, actor, "user.delete", target.uid, label),
    ]);
    return json({ deleted: target.uid });
  }
  return fail(405, "This request method is not supported.");
}
