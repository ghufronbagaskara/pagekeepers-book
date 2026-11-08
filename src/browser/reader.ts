import { brand } from "../brand";
import { bookKey, cacheShell, get, localFile, put, session, watchSession, type Book } from "./local";
import { ReadingProgress } from "./progress";
import { Bookmarks } from "./bookmarks";
import { ReadingClock, syncSessions } from "./sessions";
import { setupTimer } from "./timer";
import { setupQuote } from "./quote";
import { lang, setLang, t, translatePage } from "./i18n";

translatePage();
import { pageFilter, saveSettings, settings, stageColor, turnMs, turnSound, wireLargeToggle, type Eye, type Speed, type Turn } from "./settings";

const element = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
const status = element("status");
const hash = new URLSearchParams(location.search).get("book") ?? "";
const grant = await session();
watchSession(grant);
void cacheShell()?.catch(() => {});

function setupReaderChrome(closeThumbnails: () => void) {
  const root = element("reader");
  const header = element("reader-header");
  const tools = element("reader-tools");
  const list = element("page-list");
  const options = element<HTMLDetailsElement>("reader-options");
  const fullscreen = element<HTMLButtonElement>("fullscreen");
  let expanded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const setHidden = (hidden: boolean) => {
    root.classList.toggle("chrome-hidden", hidden);
    header.inert = tools.inert = hidden;
  };
  const show = () => {
    clearTimeout(timer);
    setHidden(false);
    if (!expanded) return;
    timer = setTimeout(() => {
      const chrome = [header, tools, list];
      const focus = document.activeElement;
      const editing = focus && (focus.matches(":focus-visible, input, select") && chrome.some((part) => part.contains(focus)));
      if (editing || document.querySelector("dialog[open]")) return;
      options.open = false;
      closeThumbnails();
      setHidden(true);
    }, 2800);
  };
  const setFullscreen = (active: boolean) => {
    expanded = active;
    root.classList.toggle("is-fullscreen", active);
    const label = active ? t("Exit full screen") : t("Full screen");
    fullscreen.setAttribute("aria-pressed", String(active));
    fullscreen.setAttribute("aria-label", label);
    fullscreen.title = label;
    show();
  };
  fullscreen.addEventListener("click", async () => {
    if (document.fullscreenElement === root) {
      await document.exitFullscreen();
    } else if (expanded) {
      setFullscreen(false);
    } else {
      try {
        if (root.requestFullscreen) await root.requestFullscreen();
      } catch {
        // Keep the reader usable when native fullscreen is unavailable in an embedded browser.
      }
      setFullscreen(true);
    }
  });
  document.addEventListener("fullscreenchange", () => setFullscreen(document.fullscreenElement === root));
  for (const event of ["pointermove", "pointerdown", "pointerout", "focusin", "focusout", "wheel"]) {
    root.addEventListener(event, () => { if (expanded) show(); }, { passive: true });
  }
  root.addEventListener("pointerdown", (event) => {
    if (!options.contains(event.target as Node)) options.open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (expanded) show();
    if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
    if (root.classList.contains("chrome-hidden")) {
      show();
    } else if (options.open) {
      options.open = false;
      options.querySelector("summary")?.focus();
    } else if (!list.hidden) {
      closeThumbnails();
      element("thumbs").focus();
    } else if (expanded && !document.fullscreenElement) {
      setFullscreen(false);
    }
  });
  // A tap in the middle of the page shows or hides the controls, in a window as well as full screen.
  return () => {
    if (root.classList.contains("chrome-hidden")) return show();
    clearTimeout(timer);
    options.open = false;
    closeThumbnails();
    setHidden(true);
  };
}

type Engine = {
  options: { keepZoom: boolean; turnStyle: Turn; duration: number };
  setSoundEnabled: (on: boolean) => void;
  container: HTMLElement;
  renderer?: { setBackground?: (color: string) => void; requestRender?: () => void };
  zoomToTop: (level: number) => number;
  fitWidthLevel: (least?: number) => number;
};
function setupReadingOptions(reader: Engine) {
  const options = element<HTMLDetailsElement>("reader-options");
  const keep = element<HTMLInputElement>("keep-zoom");
  const brightness = element<HTMLInputElement>("brightness");
  const hint = element<HTMLDialogElement>("hint-dialog");
  const paint = () => {
    const current = settings();
    element("book").style.filter = pageFilter(current);
    const color = stageColor(current.eye);
    reader.container.style.backgroundColor = color;
    reader.renderer?.setBackground?.(color);
    reader.renderer?.requestRender?.();
  };
  const prefs = settings();
  keep.checked = prefs.keepZoom;
  brightness.value = String(prefs.brightness);
  for (const radio of document.querySelectorAll<HTMLInputElement>("input[name=eye]")) {
    radio.checked = radio.value === prefs.eye;
    radio.addEventListener("change", () => { saveSettings({ eye: radio.value as Eye }); paint(); });
  }
  for (const radio of document.querySelectorAll<HTMLInputElement>("input[name=turn]")) {
    radio.checked = radio.value === prefs.turn;
    radio.addEventListener("change", () => { reader.options.turnStyle = saveSettings({ turn: radio.value as Turn }).turn; });
  }
  const speed = element<HTMLSelectElement>("turn-speed");
  speed.value = prefs.speed;
  speed.addEventListener("change", () => { reader.options.duration = turnMs[saveSettings({ speed: speed.value as Speed }).speed]; });
  const sound = element<HTMLInputElement>("turn-sound");
  sound.checked = prefs.sound;
  sound.addEventListener("change", () => reader.setSoundEnabled(saveSettings({ sound: sound.checked }).sound));
  // The renderer is chosen when the book opens, so switching it means opening the book again.
  const saver = element<HTMLInputElement>("saver");
  saver.checked = prefs.saver;
  saver.addEventListener("change", () => { saveSettings({ saver: saver.checked }); location.reload(); });
  keep.addEventListener("change", () => { reader.options.keepZoom = saveSettings({ keepZoom: keep.checked }).keepZoom; });
  brightness.addEventListener("input", () => { saveSettings({ brightness: brightness.valueAsNumber }); paint(); });
  // ponytail: a page that already fits the width still gets a 1.25 lens, which trims a scan's margins.
  element("fit-width").addEventListener("click", () => { reader.zoomToTop(reader.fitWidthLevel(1.25)); options.open = false; });
  wireLargeToggle(element<HTMLButtonElement>("large-ui"));
  const language = element<HTMLSelectElement>("lang-select");
  language.value = lang();
  language.addEventListener("change", () => setLang(language.value === "id" ? "id" : "en"));
  const showHint = () => { options.open = false; hint.returnValue = ""; hint.showModal(); };
  element("show-hint").addEventListener("click", showHint);
  hint.addEventListener("close", () => saveSettings({ hintSeen: true }));
  paint();
  if (!prefs.hintSeen) showHint();
}

async function conflict(local: number, cloud: number) {
  const dialog = element<HTMLDialogElement>("conflict");
  element("conflict-message").textContent = t("This device is on page {local}. Your synced position is page {cloud}.", { local, cloud });
  dialog.returnValue = "";
  dialog.addEventListener("cancel", (event) => event.preventDefault(), { once: true });
  dialog.showModal();
  return new Promise<boolean>((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "local"), { once: true }));
}

async function open() {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Choose a book from your library.");
  const key = bookKey(grant.uid, hash);
  const entry = await get<Book>("books", key);
  if (!entry?.path) throw new Error("Save this book to this device before opening it.");
  const file = await localFile(grant.uid, entry.path);
  if (file.size !== entry.bytes) throw new Error("The saved PDF is incomplete. Download or import it again.");
  element("book-title").textContent = entry.title;
  document.title = `${entry.title} · ${brand}`;
  const progress = new ReadingProgress(grant.uid, hash, conflict);
  const firstPage = await progress.open();
  const mode = element<HTMLSelectElement>("mode");
  const page = element<HTMLInputElement>("page-number");
  const list = element("page-list");
  const thumbs = element("thumb-items");
  const marks = new Bookmarks(grant.uid, hash);
  let showMark = (_page: number) => {};
  const setThumbnails = (open: boolean) => {
    list.hidden = !open;
    element("thumbs").setAttribute("aria-expanded", String(open));
  };
  const toggleChrome = setupReaderChrome(() => setThumbnails(false));
  const selected = localStorage.getItem(`reader-mode/${grant.uid}`);
  if (selected === "single" || selected === "double") mode.value = selected;
  const url = "/zaya/engine-next/index.js";
  const { ZayaBook } = await import(url);
  let ready = false;
  let applying = false;
  let menuTap: ReturnType<typeof setTimeout> | undefined;
  const prefs = settings();
  const reader = ZayaBook.create(element("book"), file, {
    openPage: firstPage, doubleInternal: false, hard: "cover",
    backgroundColor: stageColor(prefs.eye),
    keepZoom: prefs.keepZoom,
    turnStyle: prefs.turn, duration: turnMs[prefs.speed] ?? turnMs.normal,
    soundEnable: prefs.sound, soundUrl: turnSound(),
    // Battery saver: the plain 2D renderer instead of WebGL, and pages drawn at a lower pixel density.
    renderMode: prefs.saver ? "css" : "auto", maxPixelRatio: prefs.saver ? 1.5 : 2,
    pageMode: mode.value === "auto" ? null : mode.value,
    // Outer thirds turn the page, zoomed or not; the middle shows the controls, unless a second tap makes it a zoom.
    onTapAt: (fraction: number) => {
      if (fraction < 0.3) void reader.prev();
      else if (fraction > 0.7) void reader.next();
      else {
        clearTimeout(menuTap);
        menuTap = setTimeout(toggleChrome, 340);
      }
      return true;
    },
    zoomChange: () => clearTimeout(menuTap),
    onPageChange: (current: number) => {
      page.value = String(current);
      for (const node of list.querySelectorAll("[aria-current]")) node.removeAttribute("aria-current");
      list.querySelector(`[data-page="${current}"]`)?.setAttribute("aria-current", "page");
      showMark(current);
      if (ready && !applying) void progress.save(current).catch(() => { status.textContent = t("Your reading position could not be saved."); });
    },
  });
  await reader.ready;
  if (!reader.pageCount) throw new Error("This PDF could not be opened.");
  setupReadingOptions(reader);
  ready = true;
  page.max = String(reader.pageCount);
  element("total").textContent = `/ ${reader.pageCount}`;
  status.textContent = "";
  void progress.visit().then(() => progress.sync()).catch(() => {});
  const clock = new ReadingClock(grant.uid, hash, () => reader.activePage);

  const sync = async () => {
    try {
      await clock.save();
      void syncSessions(grant.uid);
      void marks.sync();
      await progress.sync();
      if (!reader.busy && progress.current.page !== reader.activePage) {
        applying = true;
        try { await reader.gotoPage(progress.current.page, { animate: false }); }
        finally { applying = false; }
      }
    } catch {}
  };
  setInterval(() => void sync(), 15000);
  window.addEventListener("online", () => void sync());
  document.addEventListener("visibilitychange", () => { if (document.hidden) void sync(); });  element("back").addEventListener("click", (event) => {
    event.preventDefault();
    void sync().finally(() => location.assign("/library/"));
  });
  setupTimer(clock, grant.uid, hash, () => reader.activePage, () => element("back").click());

  const markButton = element<HTMLButtonElement>("bookmark");
  const markDialog = element<HTMLDialogElement>("bookmark-dialog");
  const note = element<HTMLTextAreaElement>("bookmark-note");
  let markedPage = 1;
  showMark = (current) => {
    const saved = Boolean(marks.find(current));
    const label = saved ? t("Edit bookmark on page {page}", { page: current }) : t("Bookmark this page");
    markButton.setAttribute("aria-pressed", String(saved));
    markButton.setAttribute("aria-label", label);
    markButton.title = label;
  };
  marks.onChange = () => {
    showMark(reader.activePage);
    const items: HTMLElement[] = marks.visible.map((mark) => {
      const button = document.createElement("button");
      button.type = "button";
      const number = document.createElement("strong");
      number.textContent = t("p. {page}", { page: mark.page });
      button.append(number, mark.note ? ` ${mark.note}` : "");
      button.addEventListener("click", () => void reader.gotoPage(mark.page));
      return button;
    });
    if (!items.length) {
      const empty = document.createElement("p");
      empty.textContent = t("No bookmarks yet. Use the bookmark button to mark a page.");
      items.push(empty);
    }
    element("bookmark-items").replaceChildren(...items);
  };
  void marks.open().catch(() => {});
  markButton.addEventListener("click", () => {
    markedPage = reader.activePage;
    const saved = marks.find(markedPage);
    element("bookmark-title").textContent = `${saved ? t("Edit bookmark") : t("Bookmark")} · ${t("page {page}", { page: markedPage })}`;
    element("bookmark-remove").hidden = !saved;
    note.value = saved?.note ?? "";
    markDialog.returnValue = "";
    markDialog.showModal();
  });
  markDialog.addEventListener("close", () => {
    const choice = markDialog.returnValue;
    if (choice === "save" || choice === "remove") {
      void marks.set(markedPage, choice === "save" ? note.value : "", choice === "remove")
        .catch(() => { status.textContent = t("The bookmark could not be saved."); });
    }
  });
  element("jump").addEventListener("submit", (event) => {
    event.preventDefault();
    if (page.reportValidity()) void reader.gotoPage(page.valueAsNumber);
  });
  const action = (id: string, run: () => unknown) => element(id).addEventListener("click", () => void run());
  action("quote", setupQuote(reader, entry.title, () => { element<HTMLDetailsElement>("reader-options").open = false; }));
  action("prev", () => reader.prev());
  action("next", () => reader.next());
  action("zoom-out", () => reader.zoomOut());
  action("zoom-in", () => reader.zoomIn());
  action("zoom-reset", () => reader.resetZoom());
  action("export", () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(file);
    link.download = `${entry.title}.pdf`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
  });
  mode.addEventListener("change", () => {
    localStorage.setItem(`reader-mode/${grant.uid}`, mode.value);
    if (mode.value === "auto") {
      reader.options.pageMode = null;
      reader.onResize();
    } else void reader.setPageMode(mode.value === "single", true);
  });
  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || document.querySelector("dialog[open]") ||
        (event.target as HTMLElement | null)?.closest("input, select, textarea, [contenteditable]")) return;
    // Desktop shortcuts; letters are matched case-insensitively so Caps Lock does not get in the way.
    const keys: Record<string, () => unknown> = {
      arrowleft: () => reader.prev(), pageup: () => reader.prev(),
      arrowright: () => reader.next(), pagedown: () => reader.next(),
      home: () => reader.first(), end: () => reader.last(),
      b: () => markButton.click(), t: () => element("timer").click(), f: () => element("fullscreen").click(),
      "?": () => element("show-hint").click(),
    };
    const run = keys[event.key.toLowerCase()];
    if (!run) return;
    event.preventDefault();
    void run();
  });
  const observer = new IntersectionObserver((entries) => {
    for (const item of entries) {
      if (!item.isIntersecting) continue;
      observer.unobserve(item.target);
      const button = item.target as HTMLButtonElement;
      void reader.getThumbnail(Number(button.dataset.page), 120).then((canvas: HTMLCanvasElement) => {
        if (!canvas) return;
        const img = document.createElement("img");
        img.src = canvas.toDataURL("image/jpeg", 0.8);
        img.alt = "";
        button.prepend(img);
      }).catch(() => {});
    }
  }, { root: list, rootMargin: "100px" });
  // The page list opens on the page being read, not on page 1.
  const showCurrent = () => thumbs.querySelector("[aria-current]")?.scrollIntoView({ block: "center" });
  action("thumbs", () => {
    setThumbnails(list.hasAttribute("hidden"));
    if (list.hidden) return;
    if (thumbs.childElementCount) return showCurrent();
    const fragment = document.createDocumentFragment();
    for (let index = 1; index <= reader.pageCount; index++) {
      const button = document.createElement("button");
      button.textContent = String(index);
      button.dataset.page = String(index);
      if (index === reader.activePage) button.setAttribute("aria-current", "page");
      button.addEventListener("click", () => void reader.gotoPage(index));
      fragment.append(button);
    }
    thumbs.append(fragment);
    for (const button of thumbs.children) observer.observe(button);
    showCurrent();
  });
  if (entry.personal && (!entry.pages || !entry.cover)) {
    void (async () => {
      const canvas: HTMLCanvasElement | undefined = entry.cover ? undefined : await reader.getThumbnail(1, 240).catch(() => undefined);
      const cover = canvas && await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
      const current = await get<Book>("books", key);
      if (current?.path === entry.path) await put("books", key, { ...current, pages: reader.pageCount, cover: cover || current.cover });
    })().catch(() => {});
  }
}
void open().catch((error) => {
  status.textContent = t(error instanceof Error ? error.message : "This book could not be opened.");
});
