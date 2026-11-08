import { bookKey, cacheShell, deleteFile, get, humanBytes, localFile, lock, put, remember, remove, savedBooks, session, watchSession, type Book, type Progress } from "./local";
import { loadSessions, type Session } from "./sessions";
import { byDay, dayKey, daysBack, duration, goalMinutes, setGoalMinutes, streak } from "./stats";
import { wireLargeToggle } from "./settings";
import { locale, t, translatePage, wireLangToggle } from "./i18n";
import { setupInstall } from "./install";
import { wireThemeToggle } from "./theme";

translatePage();
wireLangToggle(document.getElementById("lang") as HTMLButtonElement);
wireThemeToggle(document.getElementById("theme") as HTMLButtonElement);

wireLargeToggle(document.getElementById("large-ui") as HTMLButtonElement);
setupInstall();

const element = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
const status = element("status");
const transfer = element("transfer");
const bar = element<HTMLProgressElement>("transfer-progress");
const picker = element<HTMLInputElement>("file");
const shelf = element("books");
const grant = await session();
watchSession(grant);
document.getElementById("admin-link")!.hidden = grant.role !== "admin";
let busy = false;
let controller: Worker | undefined;
let objectUrls: string[] = [];
let catalog: (Book & { page?: number })[] = [];
type CloudProgress = Omit<Progress, "mutation" | "visitPending"> & { hash: string };
type ShelfBook = Book & { page: number; lastReadAt: number };
let cloud = new Map<string, CloudProgress>();

async function render() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  const local = await savedBooks(grant.uid);
  const books = new Map(catalog.map((book) => [book.hash, book]));
  for (const book of local) books.set(book.hash, { ...books.get(book.hash), ...book });
  const entries = await Promise.all([...books.values()].map(async (book): Promise<ShelfBook> => {
    const saved = await get<Progress>("progress", bookKey(grant.uid, book.hash));
    const remote = cloud.get(book.hash);
    const position = saved?.mutation || (saved && saved.revision > (remote?.revision ?? -1)) ? saved : remote ?? saved;
    const lastReadAt = Math.max(saved?.lastReadAt ?? 0, remote?.lastReadAt ?? 0);
    const page = position && (position.revision || saved?.mutation || lastReadAt) ? position.page : book.page ?? 0;
    return { ...book, page, lastReadAt };
  }));
  const history = entries.filter((book) => book.lastReadAt > 0 || book.page > 0)
    .sort((a, b) => b.lastReadAt - a.lastReadAt || a.title.localeCompare(b.title, locale()));
  const [latest, ...recent] = history;
  element("continue-section").hidden = !latest;
  element("continue-book").replaceChildren(...(latest ? [cardFor(latest, "continue-card")] : []));
  element("recent-section").hidden = !recent.length;
  element("recent-books").replaceChildren(...recent.slice(0, 6).map((book) => cardFor(book, "recent-card")));
  element("book-count").textContent = t(entries.length === 1 ? "{count} book" : "{count} books", { count: entries.length });
  shelved = entries;
  element("shelf-tools").hidden = entries.length < 2;
  renderShelf();
  if (!entries.length) status.textContent = t("Your library is empty. Import a PDF to get started.");
}

// Search, filter and sort apply to "All books" only; the choice is remembered on this device.
let shelved: ShelfBook[] = [];
const search = element<HTMLInputElement>("search");
const filter = element<HTMLSelectElement>("filter");
const sort = element<HTMLSelectElement>("sort");
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
const finished = (book: ShelfBook) => Boolean(book.pages) && book.page >= book.pages!;
const share = (book: ShelfBook) => book.pages ? Math.min(1, book.page / book.pages) : 0;
const shows: Record<string, (book: ShelfBook) => boolean> = {
  all: () => true,
  reading: (book) => book.page > 0 && !finished(book),
  unread: (book) => !book.page,
  finished,
  saved: (book) => Boolean(book.path),
};
const orders: Record<string, (a: ShelfBook, b: ShelfBook) => number> = {
  // Books with a place saved but no read time (older data) still come before untouched ones.
  recent: (a, b) => b.lastReadAt - a.lastReadAt || Number(b.page > 0) - Number(a.page > 0),
  title: () => 0,
  progress: (a, b) => share(b) - share(a),
};
try {
  const view = JSON.parse(localStorage.getItem("library-view") ?? "{}");
  if (view.filter in shows) filter.value = view.filter;
  if (view.sort in orders) sort.value = view.sort;
} catch {}
function renderShelf() {
  const words = fold(search.value.trim()).split(/\s+/).filter(Boolean);
  const books = shelved
    .filter((book) => (shows[filter.value] ?? shows.all!)(book) && words.every((word) => fold(book.title).includes(word)))
    .sort((a, b) => (orders[sort.value] ?? orders.recent!)(a, b) || a.title.localeCompare(b.title, locale(), { numeric: true }));
  element("no-match").hidden = Boolean(books.length) || !shelved.length;
  shelf.replaceChildren(...books.map((book) => cardFor(book)));
}
for (const control of [filter, sort]) control.addEventListener("change", () => {
  try { localStorage.setItem("library-view", JSON.stringify({ filter: filter.value, sort: sort.value })); } catch {}
  renderShelf();
});
search.addEventListener("input", renderShelf);
element("shelf-tools").addEventListener("submit", (event) => { event.preventDefault(); search.blur(); });

let sessions: Session[] = [];
const HOUR = 3600_000;
function renderHabit() {
  const goal = goalMinutes(grant.uid) * 60000;
  const days = byDay(sessions);
  const now = Date.now();
  const today = days.get(dayKey(now)) ?? 0;
  const run = streak(days, goal, now);
  element("habit-today").textContent = duration(today);
  element("habit-goal").textContent = t("of {goal} today", { goal: duration(goal) });
  const bar = element<HTMLProgressElement>("habit-progress");
  bar.max = goal;
  bar.value = Math.min(today, goal);
  element("habit-streak").textContent = run ? t(today < goal ? "{days}-day streak. Read today to keep it going." : "{days}-day streak.", { days: run }) :
    t("Meet your goal today to start a streak.");
  element<HTMLInputElement>("goal").value = String(goal / 60000);

  // Five calendar weeks, Monday first, ending today.
  const monday = (new Date(now).getDay() + 6) % 7;
  const cells = daysBack(28 + monday + 1, now).reverse();
  const format = new Intl.DateTimeFormat(locale(), { weekday: "short", day: "numeric", month: "short" });
  const head = [...t("MTWTFSS")].map((letter) => {
    const item = document.createElement("li");
    item.className = "dow";
    item.setAttribute("aria-hidden", "true");
    item.textContent = letter;
    return item;
  });
  const items = cells.map((day, index) => {
    const read = days.get(dayKey(day)) ?? 0;
    const item = document.createElement("li");
    // Like a contribution graph: any reading lights the day, an hour brighter, two hours brightest.
    item.className = `level-${read >= 2 * HOUR ? 3 : read >= HOUR ? 2 : read ? 1 : 0}`;
    // Phones show only this week's row; see `.habit-calendar .past` in site.css.
    if (index < 28) item.classList.add("past");
    if (dayKey(day) === dayKey(now)) item.classList.add("is-today");
    item.title = `${format.format(day)}: ${duration(read)}`;
    const text = document.createElement("span");
    text.className = "visually-hidden";
    text.textContent = item.title;
    item.append(text);
    return item;
  });
  element("habit-calendar").replaceChildren(...head, ...items);
  const week = daysBack(7, now).reduce((total, day) => total + (days.get(dayKey(day)) ?? 0), 0);
  element("habit-week").textContent = t("Last 7 days: {time}", { time: duration(week) });
  element("habit").hidden = false;
}
element("goal-form").addEventListener("submit", (event) => {
  event.preventDefault();
  setGoalMinutes(grant.uid, element<HTMLInputElement>("goal").valueAsNumber);
  element("goal-form").closest("details")!.open = false;
  renderHabit();
});

function storageIcon(stored: boolean) {
  const badge = document.createElement("span");
  badge.className = `storage-icon ${stored ? "is-stored" : "needs-download"}`;
  badge.title = stored ? t("Saved on this device") : t("Not downloaded");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", stored ? "m5 12 4 4L19 6" : "M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4");
  svg.append(path);
  badge.append(svg);
  return badge;
}

function cardFor(book: ShelfBook, variant = "") {
  const card = document.createElement("article");
  card.className = ["book-card", variant].filter(Boolean).join(" ");
  const featured = variant === "continue-card";
  const cover = document.createElement(featured ? "div" : "button");
  cover.className = "cover";
  if (cover instanceof HTMLButtonElement) {
    cover.type = "button";
    cover.setAttribute("aria-label", t(book.path ? "Read {title}" : "Download and read {title}", { title: book.title }));
    cover.setAttribute("aria-describedby", `storage-${variant || "catalog"}-${book.hash}`);
  }
  const placeholder = document.createElement("span");
  placeholder.textContent = book.title;
  cover.append(placeholder);
  if (book.cover || !book.personal) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("load", () => { placeholder.hidden = true; });
    image.addEventListener("error", () => image.remove());
    if (book.cover) {
      const url = URL.createObjectURL(book.cover);
      objectUrls.push(url);
      image.src = url;
    } else image.src = `/api/cover/${book.hash}/`;
    cover.append(image);
  }
  const badge = storageIcon(Boolean(book.path));
  if (!featured) cover.append(badge);
  const title = document.createElement("h3");
  title.textContent = book.title;
  const info = document.createElement("p");
  info.className = "book-storage muted";
  if (featured) info.append(badge);
  const storage = document.createElement("span");
  storage.className = "visually-hidden";
  storage.id = `storage-${variant || "catalog"}-${book.hash}`;
  storage.textContent = badge.title + ". ";
  info.append(storage, humanBytes(book.bytes));
  const reading = document.createElement("div");
  reading.className = "book-reading";
  const label = document.createElement("p");
  label.className = "book-position";
  if (book.pages) {
    const page = Math.min(book.page, book.pages);
    const percent = Math.min(page === book.pages ? 100 : 99, Math.round(100 * page / book.pages));
    label.textContent = t("{page} / {pages} pages", { page, pages: book.pages });
    const percentage = document.createElement("span");
    percentage.textContent = `${percent}%`;
    label.append(percentage);
    const track = document.createElement("progress");
    track.max = book.pages;
    track.value = page;
    track.setAttribute("aria-label", t("Reading progress for {title}", { title: book.title }));
    reading.append(label, track);
  } else {
    label.textContent = book.page ? t("Page {page}", { page: book.page }) : t("Not started");
    reading.append(label);
  }
  const actions = document.createElement("div");
  actions.className = "book-actions";
  const open = featured ? document.createElement("button") : cover;
  if (featured && open instanceof HTMLButtonElement) {
    open.type = "button";
    open.textContent = book.path ? t("Continue reading") : t("Download and continue");
    open.className = "primary";
    actions.append(open);
  }
  open.addEventListener("click", () => {
    if (busy) return;
    void (async () => {
      if (book.path) {
        try {
          const file = await localFile(grant.uid, book.path);
          if (file.size !== book.bytes) throw new Error("The file is incomplete");
          location.assign(`/read/?book=${book.hash}`);
          return;
        } catch {
          await remove("books", bookKey(grant.uid, book.hash));
          await render();
          status.textContent = t("The saved copy is missing or damaged. Download or import the book again.");
          return;
        }
      }
      await install(book);
    })().catch(showError);
  });
  if (book.path) {
    const path = book.path;
    const erase = document.createElement("button");
    erase.type = "button";
    erase.textContent = t("Remove download");
    erase.className = "book-remove";
    erase.setAttribute("aria-label", t("Remove {title} from this device", { title: book.title }));
    erase.addEventListener("click", async () => {
      if (busy || !confirm(t("Remove the saved copy of {title} from this device?", { title: book.title }))) return;
      try {
        await deleteFile(grant.uid, path);
        await remove("books", bookKey(grant.uid, book.hash));
        await render();
        status.textContent = t("Download removed. Your place is still saved.");
      } catch (error) { showError(error); }
    });
    actions.append(erase);
  }
  const details = document.createElement("div");
  details.className = "book-details";
  details.append(title, info, reading);
  if (actions.childElementCount) details.append(actions);
  card.append(cover, details);
  return card;
}

function showError(error: unknown) {
  status.textContent = t(error instanceof Error ? error.message : "Something went wrong. Try again.");
}
async function prepareReader() {
  if (!navigator.serviceWorker) throw new Error("This browser does not support offline reading.");
  const registration = await cacheShell();
  const active = registration?.active ?? (await navigator.serviceWorker.ready).active;
  if (!active) throw new Error("Offline reading is not ready yet.");
  return new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error("Offline reading is not ready yet. Try again when online.")); }, 45000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      if (data) resolve();
      else reject(new Error("The reader could not be prepared for offline use. Try again when online."));
    };
    active.postMessage("prepare-reader", [channel.port2]);
  });
}

async function install(book: Omit<Book, "hash"> & { hash?: string }, file?: File) {
  if (busy || !book.bytes) return;
  busy = true;
  let staged: string | undefined;
  element<HTMLButtonElement>("import").disabled = true;
  transfer.hidden = false;
  element("transfer-title").textContent = book.title;
  element("transfer-text").textContent = t("Getting the reader ready for offline use…");
  bar.value = 0;
  status.textContent = "";
  try {
    if (!navigator.storage?.getDirectory) throw new Error("This browser cannot save PDFs for offline reading.");
    const { usage, quota } = await navigator.storage.estimate();
    if (usage != null && quota != null && quota - usage < book.bytes) throw new Error("There is not enough space on this device.");
    void navigator.storage.persist?.().catch(() => {});
    await prepareReader();
    element("transfer-text").textContent = `0 / ${humanBytes(book.bytes)}`;
    const worker = new Worker("/client/storage-worker.js", { type: "module" });
    controller = worker;
    const result = await new Promise<{ path: string; hash: string }>((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.error === "SESSION") {
          reject(new Error("SESSION"));
          return;
        }
        if (data.error) reject(new Error(data.error));
        else if (data.path) resolve(data);
        else {
          bar.value = Math.floor(data.loaded * 100 / book.bytes);
          element("transfer-text").textContent = `${humanBytes(data.loaded)} / ${humanBytes(book.bytes)}`;
        }
      };
      worker.onerror = () => reject(new Error("The book could not be saved on this device."));
      worker.postMessage({ uid: grant.uid, file, hash: book.hash, bytes: book.bytes });
    });
    staged = result.path;
    const key = bookKey(grant.uid, result.hash);
    const previous = await get<Book>("books", key);
    let cover: Blob | undefined = previous?.cover;
    if (!cover && !file) {
      const response = await fetch(`/api/cover/${result.hash}/`).catch(() => undefined);
      if (response?.ok) cover = await response.blob();
    }
    await put("books", key, { ...book, ...result, cover, personal: file ? previous?.personal ?? true : false });
    staged = undefined;
    if (previous?.path) await deleteFile(grant.uid, previous.path).catch(() => {});
    location.assign(`/read/?book=${result.hash}`);
  } catch (error) {
    if (staged) await deleteFile(grant.uid, staged).catch(() => {});
    if (error instanceof Error && error.message === "SESSION") lock();
    showError(error);
  } finally {
    controller?.terminate();
    controller = undefined;
    busy = false;
    element<HTMLButtonElement>("import").disabled = false;
    transfer.hidden = true;
  }
}

element("cancel").addEventListener("click", () => controller?.postMessage("cancel"));
element("import").addEventListener("click", () => picker.click());
picker.addEventListener("change", () => {
  const file = picker.files?.[0];
  if (file) void install({ title: file.name.replace(/\.pdf$/i, ""), bytes: file.size, personal: true }, file);
  picker.value = "";
});
element("logout").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/logout/", { method: "POST" });
    if (!response.ok) throw new Error("Sign-out failed. Try again.");
    remember();
    location.replace("/login/");
  } catch { status.textContent = t("Connect to the internet to sign out."); }
});

try {
  void cacheShell()?.catch(() => {});
  catalog = await get<typeof catalog>("catalog", grant.uid) ?? [];
  const progressKey = `${grant.uid}/progress`;
  const [response, progressResponse] = await Promise.all([
    fetch("/api/catalog/").catch(() => undefined),
    fetch("/api/progress/").catch(() => undefined),
  ]);
  if (response?.status === 401) lock();
  if (response?.ok) {
    catalog = await response.json();
    await put("catalog", grant.uid, catalog);
  }
  const positions: CloudProgress[] = progressResponse?.ok ? await progressResponse.json() :
    await get<CloudProgress[]>("catalog", progressKey) ?? [];
  if (progressResponse?.ok) await put("catalog", progressKey, positions);
  cloud = new Map(positions.map((position) => [position.hash, position]));
  status.textContent = response?.ok ? "" : t("Offline. Your saved books are still available.");
  await render();
  void loadSessions(grant.uid).then((loaded) => { sessions = loaded; renderHabit(); }).catch(() => {});
  element<HTMLButtonElement>("import").disabled = false;
} catch (error) { showError(error); }
