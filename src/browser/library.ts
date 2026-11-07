import { bookKey, cacheShell, deleteFile, get, humanBytes, localFile, lock, put, remember, remove, savedBooks, session, watchSession, type Book, type Progress } from "./local";
import { loadSessions, type Session } from "./sessions";
import { byDay, dayKey, daysBack, duration, goalMinutes, setGoalMinutes, streak } from "./stats";
import { wireLargeToggle } from "./settings";

wireLargeToggle(document.getElementById("large-ui") as HTMLButtonElement);

const element = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
const status = element("status");
const transfer = element("transfer");
const bar = element<HTMLProgressElement>("transfer-progress");
const picker = element<HTMLInputElement>("file");
const shelf = element("books");
const grant = await session();
watchSession(grant);
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
    .sort((a, b) => b.lastReadAt - a.lastReadAt || a.title.localeCompare(b.title, "id"));
  const [latest, ...recent] = history;
  element("continue-section").hidden = !latest;
  element("continue-book").replaceChildren(...(latest ? [cardFor(latest, "continue-card")] : []));
  element("recent-section").hidden = !recent.length;
  element("recent-books").replaceChildren(...recent.slice(0, 6).map((book) => cardFor(book, "recent-card")));
  element("book-count").textContent = `${entries.length} buku`;
  shelf.replaceChildren(...entries.map((book) => cardFor(book)));
  if (!entries.length) status.textContent = "Rak Anda masih kosong. Impor PDF untuk mulai.";
}

let sessions: Session[] = [];
function renderHabit() {
  const goal = goalMinutes(grant.uid) * 60000;
  const days = byDay(sessions);
  const now = Date.now();
  const today = days.get(dayKey(now)) ?? 0;
  const run = streak(days, goal, now);
  element("habit-today").textContent = duration(today);
  element("habit-goal").textContent = `dari ${duration(goal)} hari ini`;
  const bar = element<HTMLProgressElement>("habit-progress");
  bar.max = goal;
  bar.value = Math.min(today, goal);
  element("habit-streak").textContent = run ? `${run} hari berturut-turut${today < goal ? ". Baca hari ini supaya tidak terputus." : "."}` :
    "Capai target hari ini untuk memulai rangkaian hari membaca.";
  element<HTMLInputElement>("goal").value = String(goal / 60000);

  // Five calendar weeks, Monday first, ending today.
  const monday = (new Date(now).getDay() + 6) % 7;
  const cells = daysBack(28 + monday + 1, now).reverse();
  const format = new Intl.DateTimeFormat("id", { weekday: "short", day: "numeric", month: "short" });
  const head = ["S", "S", "R", "K", "J", "S", "M"].map((letter) => {
    const item = document.createElement("li");
    item.className = "dow";
    item.setAttribute("aria-hidden", "true");
    item.textContent = letter;
    return item;
  });
  const items = cells.map((day, index) => {
    const read = days.get(dayKey(day)) ?? 0;
    const item = document.createElement("li");
    item.className = `level-${read >= goal ? 3 : read >= goal / 2 ? 2 : read ? 1 : 0}`;
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
  element("habit-week").textContent = `7 hari terakhir: ${duration(week)}`;
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
  badge.title = stored ? "Tersimpan di perangkat ini" : "Belum diunduh";
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
    cover.setAttribute("aria-label", `${book.path ? "Baca" : "Unduh dan baca"} ${book.title}`);
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
    label.textContent = `${page} / ${book.pages} halaman`;
    const percentage = document.createElement("span");
    percentage.textContent = `${percent}%`;
    label.append(percentage);
    const track = document.createElement("progress");
    track.max = book.pages;
    track.value = page;
    track.setAttribute("aria-label", `Kemajuan membaca ${book.title}`);
    reading.append(label, track);
  } else {
    label.textContent = book.page ? `Halaman ${book.page}` : "Belum dimulai";
    reading.append(label);
  }
  const actions = document.createElement("div");
  actions.className = "book-actions";
  const open = featured ? document.createElement("button") : cover;
  if (featured && open instanceof HTMLButtonElement) {
    open.type = "button";
    open.textContent = book.path ? "Lanjut membaca" : "Unduh dan lanjutkan";
    open.className = "primary";
    actions.append(open);
  }
  open.addEventListener("click", () => {
    if (busy) return;
    void (async () => {
      if (book.path) {
        try {
          const file = await localFile(grant.uid, book.path);
          if (file.size !== book.bytes) throw new Error("File tidak lengkap");
          location.assign(`/read/?book=${book.hash}`);
          return;
        } catch {
          await remove("books", bookKey(grant.uid, book.hash));
          await render();
          status.textContent = "Salinan yang tersimpan hilang atau rusak. Unduh atau impor ulang bukunya.";
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
    erase.textContent = "Hapus unduhan";
    erase.className = "book-remove";
    erase.setAttribute("aria-label", `Hapus ${book.title} dari perangkat ini`);
    erase.addEventListener("click", async () => {
      if (busy || !confirm(`Hapus salinan ${book.title} dari perangkat ini? Posisi baca Anda tetap tersimpan.`)) return;
      try {
        await deleteFile(grant.uid, path);
        await remove("books", bookKey(grant.uid, book.hash));
        await render();
        status.textContent = "Unduhan dihapus. Posisi baca Anda tetap tersimpan.";
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
  status.textContent = error instanceof Error ? error.message : "Terjadi kesalahan. Coba lagi.";
}
async function prepareReader() {
  if (!navigator.serviceWorker) throw new Error("Browser ini tidak mendukung membaca tanpa internet.");
  const registration = await cacheShell();
  const active = registration?.active ?? (await navigator.serviceWorker.ready).active;
  if (!active) throw new Error("Mode tanpa internet belum siap.");
  return new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error("Mode tanpa internet belum siap. Coba lagi saat tersambung.")); }, 45000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      if (data) resolve();
      else reject(new Error("Pembaca belum bisa disiapkan untuk dipakai tanpa internet. Coba lagi saat tersambung."));
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
  element("transfer-text").textContent = "Menyiapkan pembaca agar bisa dipakai tanpa internet…";
  bar.value = 0;
  status.textContent = "";
  try {
    if (!navigator.storage?.getDirectory) throw new Error("Browser ini tidak bisa menyimpan PDF untuk dibaca tanpa internet.");
    const { usage, quota } = await navigator.storage.estimate();
    if (usage != null && quota != null && quota - usage < book.bytes) throw new Error("Ruang penyimpanan di perangkat ini tidak cukup.");
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
      worker.onerror = () => reject(new Error("Buku tidak dapat disimpan di perangkat ini."));
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
    if (!response.ok) throw new Error("Gagal keluar. Coba lagi.");
    remember();
    location.replace("/login/");
  } catch { status.textContent = "Sambungkan ke internet untuk keluar."; }
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
  status.textContent = response?.ok ? "" : "Sedang tidak tersambung. Buku yang sudah diunduh tetap bisa dibaca.";
  await render();
  void loadSessions(grant.uid).then((loaded) => { sessions = loaded; renderHabit(); }).catch(() => {});
  element<HTMLButtonElement>("import").disabled = false;
} catch (error) { showError(error); }
