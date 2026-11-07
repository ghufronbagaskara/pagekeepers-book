/** Reading preferences for this device. They shape how the page looks, so they stay with the screen. */
export type Eye = "normal" | "warm" | "night";
export type Settings = { large: boolean; keepZoom: boolean; eye: Eye; brightness: number; hintSeen: boolean };
const key = "reader-settings";
const defaults: Settings = { large: false, keepZoom: true, eye: "normal", brightness: 100, hintSeen: false };

export function settings(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(key) ?? "{}") };
  } catch {
    return { ...defaults };
  }
}
export function saveSettings(change: Partial<Settings>) {
  const next = { ...settings(), ...change };
  try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
  applyLarge(next);
  return next;
}
export const applyLarge = (current = settings()) => document.documentElement.classList.toggle("large-ui", current.large);

/** A CSS filter for scanned pages. Night inverts the paper, so the stage behind it is set to invert back to dark. */
export function pageFilter({ eye, brightness }: Settings) {
  const light = `brightness(${brightness / 100})`;
  if (eye === "warm") return `sepia(.45) saturate(1.1) ${light}`;
  if (eye === "night") return `invert(.88) hue-rotate(180deg) ${light}`;
  return brightness === 100 ? "" : light;
}
// invert(.88) turns this back into the stage's usual #292829.
export const stageColor = (eye: Eye) => eye === "night" ? "#f1f0f1" : "#292829";

/** The control in the library and the reader that switches the larger text and buttons on and off. */
export function wireLargeToggle(button: HTMLButtonElement) {
  const render = () => button.setAttribute("aria-pressed", String(settings().large));
  button.addEventListener("click", () => { saveSettings({ large: !settings().large }); render(); });
  render();
}
