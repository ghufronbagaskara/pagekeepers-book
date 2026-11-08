import { t } from "./i18n";

/** The "add to home screen" banner on the library: Chromium's install prompt, or the steps for iPhone and iPad. */
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const dismissedKey = "install-dismissed";
const DISMISS_MS = 30 * 86400_000;
const installed = () => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
const ios = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const dismissed = () => {
  try { return Date.now() - Number(localStorage.getItem(dismissedKey) ?? 0) < DISMISS_MS; } catch { return false; }
};

let prompt: InstallPrompt | undefined;
// Registered as soon as the module loads: Chromium fires this once, possibly before the library has rendered.
addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  prompt = event as InstallPrompt;
  show();
});
addEventListener("appinstalled", () => hide());

const banner = () => document.getElementById("install");
function hide() {
  const node = banner();
  if (node) node.hidden = true;
}
function show() {
  const node = banner();
  if (!node || installed() || dismissed()) return;
  const action = document.getElementById("install-action") as HTMLButtonElement;
  const text = document.getElementById("install-text")!;
  action.hidden = !prompt;
  text.textContent = prompt ? t("Open your library like an app, straight from the home screen.") :
    t("Tap the Share button, then “Add to Home Screen”, to open your library like an app.");
  node.hidden = false;
}

export function setupInstall() {
  const node = banner();
  if (!node) return;
  document.getElementById("install-action")!.addEventListener("click", async () => {
    const current = prompt;
    if (!current) return;
    prompt = undefined;
    hide();
    await current.prompt().catch(() => {});
  });
  document.getElementById("install-close")!.addEventListener("click", () => {
    try { localStorage.setItem(dismissedKey, String(Date.now())); } catch {}
    hide();
  });
  if (prompt || ios()) show();
}
