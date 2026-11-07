import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { hashPassword } from "better-auth/crypto";
import { api, type ReaderEnv } from "./api";

const origin = "http://localhost:4321";
const sample = "b".repeat(64);

test("catalog and PDF require a live session, mutations are same-origin, and bytes are streamed", async () => {
  const { call, db } = await fixture();
  expect((await call(`pdf/${sample}`)).status).toBe(401);
  expect((await call("login", "POST", { email: "reader@example.test", password: "local-preview-only" }, "", "https://other.test")).status).toBe(403);
  const { token, expiresAt } = await signIn(call);
  expect(expiresAt - Date.now()).toBeGreaterThan(7 * 86400000 - 5000);
  expect((await call("catalog", "GET", undefined, token)).status).toBe(200);
  const pdf = await call(`pdf/${sample}`, "GET", undefined, token);
  expect(pdf.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await pdf.text()).toBe("%PDF-");
  db.run("UPDATE sessions SET expires_at = 1");
  expect((await call("session", "GET", undefined, token)).status).toBe(401);
  const again = await signIn(call);
  db.run("UPDATE accounts SET active = 0");
  expect((await call(`pdf/${sample}`, "GET", undefined, again.token)).status).toBe(401);
  db.close();
});

test("two devices sync page 50, preserve a stale device change for explicit resolution, and can move backwards", async () => {
  const { call, db } = await fixture();
  const deviceA = await signIn(call);
  const deviceB = await signIn(call);
  const route = `progress/${sample}`;
  const first = { page: 50, revision: 0, mutation: crypto.randomUUID() };
  const created = await call(route, "PUT", first, deviceA.token);
  expect(await created.json()).toMatchObject({ ...first, revision: 1 });
  const retry = await call(route, "PUT", first, deviceA.token);
  expect((await retry.json() as { revision: number }).revision).toBe(1);
  const fetched = await call(route, "GET", undefined, deviceB.token);
  expect((await fetched.json() as { page: number }).page).toBe(50);
  const stale = { page: 39, revision: 0, mutation: crypto.randomUUID() };
  const conflict = await call(route, "PUT", stale, deviceB.token);
  expect(conflict.status).toBe(409);
  expect((await conflict.json() as { page: number }).page).toBe(50);
  const resolved = await call(route, "PUT", { ...stale, revision: 1 }, deviceB.token);
  expect(await resolved.json()).toMatchObject({ ...stale, revision: 2 });
  const lastReadAt = Date.now();
  expect((await call(route, "POST", { lastReadAt }, deviceA.token)).status).toBe(200);
  expect(await (await call(route, "POST", { lastReadAt: lastReadAt - 60_000 }, deviceB.token)).json())
    .toEqual({ lastReadAt });
  expect(await (await call("progress", "GET", undefined, deviceB.token)).json())
    .toEqual([{ hash: sample, page: 39, revision: 2, lastReadAt }]);
  const privateHash = "a".repeat(64);
  expect((await call(`progress/${privateHash}`, "PUT", { ...first, page: 19 }, deviceA.token)).status).toBe(200);
  expect(await (await call(`progress/${privateHash}`, "GET", undefined, deviceB.token)).json()).toMatchObject({ page: 19 });
  db.close();
});

test("reading sessions are idempotent, only grow, and stay with their reader", async () => {
  const { call, db } = await fixture();
  const { token } = await signIn(call);
  const startedAt = Date.now() - 600_000;
  const own = { id: crypto.randomUUID(), hash: sample, startedAt, activeMs: 60_000, pageStart: 3, pageEnd: 5 };
  expect((await call("sessions", "PUT", { sessions: [own] })).status).toBe(401);
  expect((await call("sessions", "PUT", { sessions: [own] }, token)).status).toBe(200);
  expect((await call("sessions", "PUT", { sessions: [own] }, token)).status).toBe(200);
  expect((await call("sessions", "PUT", { sessions: [{ ...own, activeMs: 120_000, pageEnd: 9 }] }, token)).status).toBe(200);
  expect((await call("sessions", "PUT", { sessions: [{ ...own, activeMs: 30_000, pageEnd: 4 }] }, token)).status).toBe(200);
  expect((await call("sessions", "PUT", { sessions: [{ ...own, activeMs: 0 }] }, token)).status).toBe(400);
  expect((await call("sessions", "PUT", { sessions: [{ ...own, id: "x" }] }, token)).status).toBe(400);

  const foreign = crypto.randomUUID();
  db.run("INSERT INTO accounts(uid) VALUES ('someone-else')");
  db.run("INSERT INTO reading_sessions VALUES (?, 'someone-else', ?, ?, 1000, 1, 1)", [foreign, sample, startedAt]);
  await call("sessions", "PUT", { sessions: [{ ...own, id: foreign, activeMs: 999_999 }] }, token);
  expect(db.query("SELECT active_ms FROM reading_sessions WHERE id = ?").get(foreign)).toEqual({ active_ms: 1000 });

  expect(await (await call(`sessions?since=${startedAt - 1}`, "GET", undefined, token)).json())
    .toEqual([{ ...own, activeMs: 120_000, pageEnd: 9 }]);
  expect(await (await call(`sessions?since=${startedAt + 1}`, "GET", undefined, token)).json()).toEqual([]);
  db.close();
});

test("bookmarks keep the newest write per page and sync removals", async () => {
  const { call, db } = await fixture();
  const { token } = await signIn(call);
  const route = `bookmarks/${sample}`;
  const mark = { page: 12, note: " Chapter 2 ", deleted: false, updatedAt: Date.now() - 1000 };
  expect(await (await call(route, "PUT", mark, token)).json()).toEqual({ page: 12, note: "Chapter 2", updatedAt: mark.updatedAt, deleted: 0 });
  const stale = await call(route, "PUT", { ...mark, note: "old", updatedAt: mark.updatedAt - 1 }, token);
  expect((await stale.json() as { note: string }).note).toBe("Chapter 2");
  const future = Date.now() + 86_400_000;
  const removed = await (await call(route, "PUT", { ...mark, deleted: true, updatedAt: future }, token)).json() as { deleted: number; updatedAt: number };
  expect(removed.deleted).toBe(1);
  expect(removed.updatedAt).toBeLessThanOrEqual(Date.now());
  expect((await call(route, "PUT", { ...mark, page: 101 }, token)).status).toBe(400);
  expect((await call(route, "PUT", { ...mark, note: "x".repeat(501) }, token)).status).toBe(400);
  expect(await (await call(route, "GET", undefined, token)).json()).toEqual([{ ...removed, page: 12, note: "Chapter 2" }]);
  db.close();
});

test("D1 sign-in keeps existing progress, issues a fixed session, and honors expiry and deactivation", async () => {
  const { call, db } = await fixture(true);
  try {
    const uid = "existing-reader";
    const email = "reader@example.test";
    const password = crypto.randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO accounts(uid) VALUES (?)", [uid]);
    db.run("INSERT INTO progress(uid, hash, page, revision, mutation) VALUES (?, ?, 50, 1, '')", [uid, sample]);
    db.run("INSERT INTO auth_user(id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)",
      [uid, email, email, now, now]);
    db.run("INSERT INTO auth_account(id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('credential', ?, 'credential', ?, ?, ?, ?)",
      [uid, uid, await hashPassword(password), now, now]);

    expect((await call("login", "POST", { email, password: "local-preview-only" })).status).toBe(401);
    const signIn = () => call("login", "POST", { email: email.toUpperCase(), password });
    const response = await signIn();
    expect(response.status).toBe(200);
    const session = await response.json() as { uid: string; expiresAt: number };
    expect(Object.keys(session).sort()).toEqual(["expiresAt", "uid"]);
    expect(session.uid).toBe(uid);
    expect(session.expiresAt - Date.now()).toBeGreaterThan(7 * 86400000 - 5000);
    const cookie = response.headers.getSetCookie()[0]!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const token = cookie.split(";")[0];
    expect(await (await call(`progress/${sample}`, "GET", undefined, token)).json()).toMatchObject({ page: 50 });
    db.run("UPDATE auth_session SET expiresAt = ?", [new Date(0).toISOString()]);
    expect((await call("catalog", "GET", undefined, token)).status).toBe(401);
    const second = await signIn();
    const next = second.headers.getSetCookie()[0]!.split(";")[0];
    expect((await call("catalog", "GET", undefined, next)).status).toBe(200);
    db.run("UPDATE accounts SET active = 0 WHERE uid = ?", [uid]);
    expect((await call("catalog", "GET", undefined, next)).status).toBe(401);
    expect((await signIn()).status).toBe(401);
    expect((await call("auth/sign-up/email", "POST", { email, password })).status).toBe(401);
  } finally {
    db.close();
  }
});

async function fixture(production = false) {
  const db = new Database(":memory:");
  for (const migration of ["0001_reader.sql", "0002_reading_history.sql", "0003_better_auth.sql", "0004_sessions_bookmarks.sql"]) {
    db.run(await Bun.file("migrations/" + migration).text());
  }
  db.run("INSERT INTO books(hash,title,bytes,pages) VALUES (?, 'Sample', 5, 100)", [sample]);
  function prepare(statement: string, values: (string | number)[] = []) {
    const query = db.query(statement);
    return {
      bind: (...args: (string | number)[]) => prepare(statement, args),
      first: async (column?: string) => {
        const row = query.get(...values) as Record<string, unknown> | null;
        return column ? row?.[column] ?? null : row;
      },
      all: async () => ({ results: query.all(...values), meta: {} }),
      run: async () => query.run(...values),
    };
  }
  const env = {
    DB: {
      prepare,
      exec: (statement: string) => db.run(statement),
      batch: async (queries: { all: () => unknown }[]) => Promise.all(queries.map((query) => query.all())),
    },
    FILES: { get: async () => ({ size: 5, body: new Blob(["%PDF-"]).stream() }) },
    ...(production ? { BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID() } : { LOCAL_PREVIEW: "1" }),
  } as unknown as ReaderEnv;
  const base = production ? "https://pagekeepers.example.test" : origin;
  const call = (path: string, method = "GET", data?: unknown, token = "", from = base) => {
    const [route, query] = path.split("?");
    return api(new Request(`${base}/api/${route}/${query ? "?" + query : ""}`, {
      method, headers: { Origin: from, Cookie: token, "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    }), route!, env);
  };
  return { call, db };
}
async function signIn(call: Awaited<ReturnType<typeof fixture>>["call"]) {
  const response = await call("login", "POST", { email: "reader@example.test", password: "local-preview-only" });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("Set-Cookie")!;
  expect(cookie).toContain("Max-Age=604800; HttpOnly; Secure; SameSite=Lax");
  const { expiresAt } = await response.json() as { expiresAt: number };
  return { token: cookie.split(";")[0], expiresAt };
}
