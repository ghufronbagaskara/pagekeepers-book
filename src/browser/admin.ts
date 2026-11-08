import { lock, session } from "./local";
import { locale, t, translatePage, wireLangToggle } from "./i18n";
import { wireThemeToggle } from "./theme";

translatePage();
wireLangToggle(document.getElementById("lang") as HTMLButtonElement);
wireThemeToggle(document.getElementById("theme") as HTMLButtonElement);

type User = { uid: string; email: string | null; name: string | null; role: "user" | "admin"; active: number; createdAt: string | null; lastReadAt: number | null; sessions: number };
type Entry = { id: number; at: number; actor: string | null; actor_email: string | null; action: string; target: string | null; detail: string; ip: string | null };

const element = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
const status = element("status");
const grant = await session();
if (grant.role !== "admin") {
  location.replace("/library/");
  throw new Error("NOT_ADMIN");
}

const when = new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" });
const day = new Intl.DateTimeFormat(locale(), { dateStyle: "medium" });
const events: Record<string, string> = {
  "login.success": "Signed in", "login.failure": "Sign-in failed", "login.blocked": "Blocked sign-in (inactive)", "logout": "Signed out",
  "user.create": "Account created", "user.disable": "Account disabled", "user.enable": "Account enabled", "user.role": "Role changed",
  "user.password": "Password reset", "user.revoke": "Sessions ended", "user.delete": "Account deleted",
};

async function call<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  const [route, query] = path.split("?");
  const response = await fetch(`/api/admin/${route}/${query ? "?" + query : ""}`, {
    method, cache: "no-store",
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (response.status === 401) lock();
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(t(payload.error ?? "Something went wrong. Try again."));
  return payload as T;
}
function cell(text: string, className = "") {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}
function badge(text: string, tone: string) {
  const td = document.createElement("td");
  const span = document.createElement("span");
  span.className = `badge ${tone}`;
  span.textContent = text;
  td.append(span);
  return td;
}
const show = (error: unknown) => { status.textContent = error instanceof Error ? error.message : t("Something went wrong. Try again."); };

// Tabs, with arrow keys moving between them.
const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
function select(tab: HTMLButtonElement) {
  for (const other of tabs) {
    const on = other === tab;
    other.setAttribute("aria-selected", String(on));
    other.tabIndex = on ? 0 : -1;
    element(other.getAttribute("aria-controls")!).hidden = !on;
  }
  status.textContent = "";
  const load = { "tab-overview": overview, "tab-users": users, "tab-audit": () => audit(true) }[tab.id];
  void load?.().catch(show);
}
for (const tab of tabs) {
  tab.addEventListener("click", () => select(tab));
  tab.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length]!;
    next.focus();
    select(next);
  });
}

function entryRow(entry: Entry, withIp: boolean) {
  const row = document.createElement("tr");
  row.append(
    cell(when.format(entry.at), "nowrap"),
    badge(t(events[entry.action] ?? entry.action), entry.action === "login.failure" || entry.action === "login.blocked" || entry.action === "user.delete" ? "is-bad" : ""),
    cell(entry.actor_email ?? entry.actor ?? "—"),
    cell(entry.detail || entry.target || ""),
  );
  if (withIp) row.append(cell(entry.ip ?? "—", "nowrap"));
  return row;
}

async function overview() {
  const data = await call<{ users: { total: number; active: number; admins: number }; books: number; readingMinutes: number; recent: Entry[] }>("overview");
  const number = new Intl.NumberFormat(locale());
  element("stat-users").textContent = number.format(data.users.total);
  element("stat-active").textContent = number.format(data.users.active);
  element("stat-admins").textContent = number.format(data.users.admins);
  element("stat-books").textContent = number.format(data.books);
  element("stat-minutes").textContent = number.format(data.readingMinutes);
  element("recent").replaceChildren(...data.recent.map((entry) => entryRow(entry, false)));
  if (!data.recent.length) element("recent").append(emptyRow(4, "No activity yet."));
}
function emptyRow(span: number, text: string) {
  const row = document.createElement("tr");
  const td = cell(t(text), "muted");
  td.colSpan = span;
  row.append(td);
  return row;
}

let list: User[] = [];
async function users() {
  list = await call<User[]>("users");
  element("users").replaceChildren(...list.map((user) => {
    const row = document.createElement("tr");
    const who = document.createElement("td");
    const email = document.createElement("strong");
    email.textContent = user.email ?? user.uid;
    who.append(email);
    if (user.name && user.name !== user.email) {
      const name = document.createElement("span");
      name.className = "muted admin-sub";
      name.textContent = user.name;
      who.append(name);
    }
    const actions = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    if (user.uid === grant.uid) {
      button.disabled = true;
      button.textContent = t("You");
    } else {
      button.textContent = t("Manage");
      button.addEventListener("click", () => manage(user.uid));
    }
    actions.append(button);
    row.append(
      who,
      badge(t(user.role === "admin" ? "Admin" : "User"), user.role === "admin" ? "is-accent" : ""),
      badge(t(user.active ? "Active" : "Disabled"), user.active ? "is-ok" : "is-bad"),
      cell(user.lastReadAt ? day.format(user.lastReadAt) : t("Never"), "nowrap"),
      cell(user.createdAt ? day.format(Date.parse(user.createdAt)) : "—", "nowrap"),
      actions,
    );
    return row;
  }));
}

let auditCursor = 0;
async function audit(reset: boolean) {
  if (reset) auditCursor = 0;
  const kind = (element<HTMLSelectElement>("audit-kind")).value;
  const query = new URLSearchParams({ kind, ...(auditCursor ? { before: String(auditCursor) } : {}) });
  const data = await call<{ entries: Entry[]; more: boolean }>(`audit?${query}`);
  const rows = data.entries.map((entry) => entryRow(entry, true));
  if (reset) element("audit").replaceChildren(...rows); else element("audit").append(...rows);
  if (reset && !rows.length) element("audit").append(emptyRow(5, "No activity yet."));
  auditCursor = data.entries.at(-1)?.id ?? auditCursor;
  element("audit-more").hidden = !data.more;
}
element("audit-kind").addEventListener("change", () => void audit(true).catch(show));
element("audit-more").addEventListener("click", () => void audit(false).catch(show));

// Add a user.
const addDialog = element<HTMLDialogElement>("add-dialog");
const addForm = element<HTMLFormElement>("add-form");
const addStatus = addForm.querySelector<HTMLElement>(".notice")!;
element("add-user").addEventListener("click", () => {
  addForm.reset();
  addStatus.textContent = "";
  addDialog.showModal();
});
addForm.addEventListener("submit", async (event) => {
  if ((event.submitter as HTMLButtonElement | null)?.value !== "save") return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(addForm));
  const submit = event.submitter as HTMLButtonElement;
  submit.disabled = true;
  try {
    await call("users", "POST", data);
    addDialog.close();
    status.textContent = t("Created an account for {email}.", { email: String(data.email).trim().toLowerCase() });
    await users();
  } catch (error) {
    addStatus.textContent = error instanceof Error ? error.message : "";
  } finally {
    submit.disabled = false;
  }
});

// Manage one user.
const manageDialog = element<HTMLDialogElement>("manage-dialog");
const manageStatus = element("manage-status");
let current: User | undefined;
function renderManage() {
  if (!current) return;
  const label = current.email ?? current.uid;
  element("manage-title").textContent = label;
  element("manage-meta").textContent = [
    t(current.role === "admin" ? "Admin" : "User"),
    t(current.active ? "Active" : "Disabled"),
    t("{count} active sessions", { count: current.sessions }),
  ].join(" · ");
  element("toggle-active").textContent = t(current.active ? "Disable account" : "Enable account");
  element("toggle-role").textContent = t(current.role === "admin" ? "Make user" : "Make admin");
  element("delete-label").textContent = t("Type {email} to confirm", { email: label });
}
function manage(uid: string) {
  current = list.find((user) => user.uid === uid);
  if (!current) return;
  manageStatus.textContent = "";
  for (const form of manageDialog.querySelectorAll("form")) form.reset();
  renderManage();
  manageDialog.showModal();
}
async function change(run: () => Promise<User>, done: string) {
  manageStatus.textContent = "";
  const buttons = manageDialog.querySelectorAll("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    current = await run();
    manageStatus.textContent = t(done);
    renderManage();
    await users();
  } catch (error) {
    manageStatus.textContent = error instanceof Error ? error.message : "";
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}
element("toggle-active").addEventListener("click", () => {
  const active = !current!.active;
  void change(() => call(`users/${current!.uid}`, "PATCH", { active }), active ? "Account enabled." : "Account disabled and signed out.");
});
element("toggle-role").addEventListener("click", () => {
  const role = current!.role === "admin" ? "user" : "admin";
  void change(() => call(`users/${current!.uid}`, "PATCH", { role }), "Role changed.");
});
element("revoke").addEventListener("click", () => void change(() => call(`users/${current!.uid}/revoke`, "POST", {}), "All sessions ended."));
element<HTMLFormElement>("password-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const password = new FormData(form).get("password");
  void change(() => call(`users/${current!.uid}/password`, "PUT", { password }), "Password changed. The reader has been signed out.")
    .then(() => form.reset());
});
element<HTMLFormElement>("delete-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const confirm = new FormData(event.currentTarget as HTMLFormElement).get("confirm");
  const label = current!.email ?? current!.uid;
  try {
    await call(`users/${current!.uid}`, "DELETE", { confirm });
    manageDialog.close();
    status.textContent = t("Deleted {email}.", { email: label });
    await users();
  } catch (error) {
    manageStatus.textContent = error instanceof Error ? error.message : "";
  }
});
element("manage-close").addEventListener("click", () => manageDialog.close());

status.textContent = "";
select(tabs[0]!);
