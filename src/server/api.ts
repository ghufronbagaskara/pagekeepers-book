import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { createAuth, sessionLifetime as lifetime } from "./auth";

export type ReaderEnv = {
  DB: D1Database;
  FILES: R2Bucket;
  BETTER_AUTH_SECRET?: string;
  AUTH_THROTTLE?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  LOCAL_PREVIEW?: string;
};

const cookieName = "__Host-reader";
const hashPattern = /^[a-f0-9]{64}$/;
const noStore = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const json = (data: unknown, status = 200, headers?: Record<string, string>) =>
  Response.json(data, { status, headers: { ...noStore, ...headers } });
const fail = (status: number, error: string) => json({ error }, status);
const cookie = (token: string, age: number) =>
  `${cookieName}=${token}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
const tokenFrom = (request: Request) =>
  request.headers.get("Cookie")?.match(/(?:^|;\s*)__Host-reader=([a-f0-9]{64})(?:;|$)/)?.[1];
const hex = (buffer: ArrayBuffer | Uint8Array) => Buffer.from(buffer as Uint8Array).toString("hex");
const digest = async (token: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
const isPreview = (request: Request, env: ReaderEnv) =>
  env.LOCAL_PREVIEW === "1" && ["localhost", "127.0.0.1"].includes(new URL(request.url).hostname);
const authFor = (request: Request, env: ReaderEnv) => env.BETTER_AUTH_SECRET
  ? createAuth(env.DB, env.BETTER_AUTH_SECRET, new URL(request.url).origin)
  : undefined;
const activeAccount = (env: ReaderEnv, uid: string) =>
  env.DB.prepare("SELECT active FROM accounts WHERE uid = ?").bind(uid).first<number>("active");
function withCookies(data: unknown, response: Response, clearPreview = false) {
  const result = json(data);
  for (const value of response.headers.getSetCookie()) result.headers.append("Set-Cookie", value);
  if (clearPreview) result.headers.append("Set-Cookie", cookie("", 0));
  return result;
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.body || !request.headers.get("Content-Type")?.startsWith("application/json")) return null;
  const reader = request.body.getReader();
  const data = new Uint8Array(4096);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > data.length) {
        await reader.cancel();
        return null;
      }
      data.set(value, offset);
      offset += value.length;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(data.subarray(0, offset)));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function login(request: Request, env: ReaderEnv) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  if (env.AUTH_THROTTLE && !(await env.AUTH_THROTTLE.limit({ key: ip })).success) {
    return fail(429, "Too many attempts. Try again in a minute.");
  }
  const input = await body(request);
  const email = typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input?.password === "string" ? input.password : "";
  if (!email || email.length > 254 || !password || password.length > 128) return fail(400, "Enter your email and password.");

  const local = isPreview(request, env);
  if (!(local && email === "reader@example.test" && password === "local-preview-only")) {
    const auth = authFor(request, env);
    if (!auth) return fail(503, "Sign-in is temporarily unavailable. Try again shortly.");
    const response = await auth.api.signInEmail({
      body: { email, password }, headers: request.headers, asResponse: true,
    });
    if (response.status === 429) return fail(429, "Too many attempts. Try again in a minute.");
    if (response.status >= 500) return fail(503, "Sign-in is temporarily unavailable. Try again shortly.");
    if (!response.ok) return fail(401, "Check your email and password, then try again.");
    const { user, token } = await response.json() as { user: { id: string }; token: string };
    const uid = user.id;
    if (await activeAccount(env, uid) !== 1) {
      await env.DB.prepare("DELETE FROM auth_session WHERE token = ? AND userId = ?").bind(token, uid).run();
      return fail(401, "This account is inactive.");
    }
    const session = await env.DB.prepare("SELECT expiresAt FROM auth_session WHERE token = ? AND userId = ?")
      .bind(token, uid).first<string>("expiresAt");
    const expiresAt = session ? Date.parse(session) : NaN;
    if (!Number.isFinite(expiresAt)) return fail(503, "Sign-in is temporarily unavailable. Try again shortly.");
    return withCookies({ uid, expiresAt }, response, local);
  }

  const uid = "local-reader";
  await env.DB.prepare("INSERT INTO accounts(uid) VALUES (?) ON CONFLICT DO NOTHING").bind(uid).run();
  if (await activeAccount(env, uid) !== 1) return fail(401, "This account is inactive.");

  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = Date.now() + lifetime * 1000;
  const previous = tokenFrom(request);
  const operations = [
    env.DB.prepare("DELETE FROM sessions WHERE uid = ? AND expires_at <= ?").bind(uid, Date.now()),
    env.DB.prepare("INSERT INTO sessions(token_hash, uid, expires_at) VALUES (?, ?, ?)").bind(await digest(token), uid, expiresAt),
  ];
  if (previous) operations.push(env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await digest(previous)));
  await env.DB.batch(operations);
  return json({ uid, expiresAt }, 200, { "Set-Cookie": cookie(token, lifetime) });
}

type ReadingSession = { id: string; hash: string; startedAt: number; activeMs: number; pageStart: number; pageEnd: number };
const whole = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
function validSession(value: unknown, now: number): value is ReadingSession {
  const item = value as Partial<ReadingSession> | null;
  return typeof item?.id === "string" && /^[a-f0-9-]{36}$/.test(item.id) &&
    typeof item.hash === "string" && hashPattern.test(item.hash) &&
    whole(item.startedAt, 1, now + 86_400_000) && whole(item.activeMs, 1, 86_400_000) &&
    whole(item.pageStart, 1, 100_000) && whole(item.pageEnd, 1, 100_000);
}

async function bookmarks(request: Request, env: ReaderEnv, uid: string, hash: string) {
  const current = (page: number) => env.DB.prepare(
    "SELECT page, note, updated_at AS updatedAt, deleted FROM bookmarks WHERE uid = ? AND hash = ? AND page = ?",
  ).bind(uid, hash, page).first();
  if (request.method === "GET") {
    return json((await env.DB.prepare(
      "SELECT page, note, updated_at AS updatedAt, deleted FROM bookmarks WHERE uid = ? AND hash = ? ORDER BY page",
    ).bind(uid, hash).all()).results);
  }
  if (request.method !== "PUT") return fail(405, "This request method is not supported.");
  const { page, note, deleted, updatedAt } = await body(request) ?? {};
  const now = Date.now();
  if (!whole(page, 1, 100_000) || typeof note !== "string" || note.length > 500 ||
      typeof deleted !== "boolean" || !whole(updatedAt, 1, Number.MAX_SAFE_INTEGER)) {
    return fail(400, "The bookmark is invalid.");
  }
  const pages = await env.DB.prepare("SELECT pages FROM books WHERE hash = ?").bind(hash).first<number>("pages");
  if (pages && page > pages) return fail(400, "That page is outside the book.");
  // Last write wins per page. A device clock running ahead cannot pin a bookmark forever.
  await env.DB.prepare(`
    INSERT INTO bookmarks(uid, hash, page, note, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(uid, hash, page) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at, deleted = excluded.deleted
    WHERE excluded.updated_at > bookmarks.updated_at
  `).bind(uid, hash, page, note.trim(), Math.min(updatedAt, now), deleted ? 1 : 0).run();
  return json(await current(page));
}

export async function api(request: Request, path: string, env: ReaderEnv): Promise<Response> {
  try {
    return await route(request, path.replace(/\/$/, ""), env);
  } catch (error) {
    console.error("Reader API error", error instanceof Error ? error.name : "Error");
    return fail(503, "The service is temporarily unavailable. Try again shortly.");
  }
}

async function route(request: Request, path: string, env: ReaderEnv) {
  const method = request.method;
  if (!["GET", "HEAD"].includes(method) && request.headers.get("Origin") !== new URL(request.url).origin) {
    return fail(403, "This request must come from Pagekeepers.");
  }
  if (path === "login" && method === "POST") return login(request, env);
  const local = isPreview(request, env);
  const token = local ? tokenFrom(request) : undefined;
  const tokenHash = token && await digest(token);
  const auth = authFor(request, env);
  if (path === "logout" && method === "POST") {
    if (tokenHash) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    if (auth) {
      const response = await auth.api.signOut({ headers: request.headers, asResponse: true });
      if (!response.ok) return fail(503, "Could not sign out. Try again shortly.");
      return withCookies({}, response, local);
    }
    return json({}, 200, { "Set-Cookie": cookie("", 0) });
  }
  const previewSession = tokenHash && await env.DB.prepare(
    "SELECT s.uid, s.expires_at AS expiresAt FROM sessions s JOIN accounts a ON a.uid = s.uid WHERE s.token_hash = ? AND s.expires_at > ? AND a.active = 1",
  ).bind(tokenHash, Date.now()).first<{ uid: string; expiresAt: number }>();
  const authenticated = !previewSession && auth && await auth.api.getSession({ headers: request.headers });
  const session = previewSession || (authenticated && await activeAccount(env, authenticated.user.id) === 1
    ? { uid: authenticated.user.id, expiresAt: new Date(authenticated.session.expiresAt).getTime() }
    : null);
  if (!session) return fail(401, "Sign in again to continue.");
  if (path === "session" && method === "GET") return json(session);
  if (path === "catalog" && method === "GET") {
    return json((await env.DB.prepare("SELECT b.hash, b.title, b.bytes, b.pages, p.page FROM books b LEFT JOIN progress p ON p.hash = b.hash AND p.uid = ? ORDER BY b.title COLLATE NOCASE").bind(session.uid).all()).results);
  }
  if (path === "progress" && method === "GET") {
    return json((await env.DB.prepare(
      "SELECT hash, page, revision, last_read_at AS lastReadAt FROM progress WHERE uid = ?",
    ).bind(session.uid).all()).results);
  }
  if (path === "sessions" && method === "GET") {
    const since = Number(new URL(request.url).searchParams.get("since"));
    return json((await env.DB.prepare(`
      SELECT id, hash, started_at AS startedAt, active_ms AS activeMs, page_start AS pageStart, page_end AS pageEnd
      FROM reading_sessions WHERE uid = ? AND started_at >= ? ORDER BY started_at
    `).bind(session.uid, Number.isSafeInteger(since) && since > 0 ? since : 0).all()).results);
  }
  if (path === "sessions" && method === "PUT") {
    const input = (await body(request))?.sessions;
    const now = Date.now();
    if (!Array.isArray(input) || !input.length || input.length > 20 || !input.every((item) => validSession(item, now))) {
      return fail(400, "The reading sessions are invalid.");
    }
    // A session grows while the reader keeps reading, so a resend may only extend it, never shrink or steal it.
    await env.DB.batch(input.map((item: ReadingSession) => env.DB.prepare(`
      INSERT INTO reading_sessions(id, uid, hash, started_at, active_ms, page_start, page_end) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET active_ms = excluded.active_ms, page_end = excluded.page_end
      WHERE reading_sessions.uid = excluded.uid AND excluded.active_ms > reading_sessions.active_ms
    `).bind(item.id, session.uid, item.hash, item.startedAt, item.activeMs, item.pageStart, item.pageEnd)));
    return json({ saved: input.length });
  }
  const [kind, hash, extra] = path.split("/");
  if (extra !== undefined || !hashPattern.test(hash ?? "")) return fail(404, "Not found.");
  if (kind === "bookmarks") return bookmarks(request, env, session.uid, hash!);
  if (["cover", "pdf"].includes(kind) && ["GET", "HEAD"].includes(method)) {
    const exists = await env.DB.prepare("SELECT 1 FROM books WHERE hash = ?").bind(hash).first();
    if (!exists) return fail(404, "This book could not be found.");
    const key = `${hash}.${kind === "pdf" ? "pdf" : "jpg"}`;
    const object = method === "HEAD" ? await env.FILES.head(key) : await env.FILES.get(key);
    if (!object) return fail(404, "This file could not be found.");
    return new Response("body" in object ? object.body as ReadableStream<Uint8Array> : null, {
      headers: {
        ...noStore, "Content-Length": String(object.size),
        "Content-Type": kind === "pdf" ? "application/pdf" : "image/jpeg",
        ...(kind === "pdf" ? { "Content-Disposition": "attachment" } : {}),
      },
    });
  }
  if (kind !== "progress") return fail(404, "Not found.");
  const read = () => env.DB.prepare("SELECT page, revision, mutation, last_read_at AS lastReadAt FROM progress WHERE uid = ? AND hash = ?")
    .bind(session.uid, hash).first<{ page: number; revision: number; mutation: string; lastReadAt: number }>();
  if (method === "GET") return json(await read() ?? { page: 1, revision: 0 });
  const change = await body(request);
  const now = Date.now();
  const activity = change?.lastReadAt;
  const lastReadAt = typeof activity === "number" && Number.isSafeInteger(activity) && activity > 0
    ? Math.min(activity, now) : now;
  if (method === "POST") {
    const visit = await env.DB.prepare(`
      INSERT INTO progress(uid, hash, page, revision, mutation, last_read_at)
      VALUES (?, ?, 1, 0, '', ?)
      ON CONFLICT(uid, hash) DO UPDATE SET last_read_at = MAX(progress.last_read_at, excluded.last_read_at)
      RETURNING last_read_at AS lastReadAt
    `).bind(session.uid, hash, lastReadAt).first();
    return json(visit);
  }
  if (method !== "PUT") return fail(405, "This request method is not supported.");
  const { page, revision, mutation } = change ?? {};
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1 || page > 100_000 ||
      typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 ||
      typeof mutation !== "string" || !/^[a-f0-9-]{36}$/.test(mutation)) {
    return fail(400, "The reading position is invalid.");
  }
  const catalogPages = await env.DB.prepare("SELECT pages FROM books WHERE hash = ?").bind(hash).first<number>("pages");
  if (catalogPages && page > catalogPages) return fail(400, "That page is outside the book.");
  const updated = await env.DB.prepare(`
    INSERT INTO progress(uid, hash, page, revision, mutation, last_read_at)
    SELECT ?1, ?2, ?3, 1, ?4, ?6
    WHERE ?5 = 0 OR EXISTS (SELECT 1 FROM progress WHERE uid = ?1 AND hash = ?2)
    ON CONFLICT(uid, hash) DO UPDATE SET page = ?3, revision = progress.revision + 1, mutation = ?4,
      last_read_at = MAX(progress.last_read_at, ?6)
    WHERE progress.revision = ?5 AND progress.mutation != ?4
    RETURNING page, revision, mutation, last_read_at AS lastReadAt
  `).bind(session.uid, hash, page, mutation, revision, lastReadAt).first();
  if (updated) return json(updated);
  const current = await read();
  return current?.mutation === mutation ? json(current) : json(current ?? { page: 1, revision: 0 }, 409);
}
