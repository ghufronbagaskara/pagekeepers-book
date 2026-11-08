/** Reading preferences for this device. They shape how the page looks, so they stay with the screen. */
export type Eye = "normal" | "warm" | "night";
export type Turn = "curl" | "slide" | "none";
export type Speed = "fast" | "normal" | "slow";
export type Settings = {
  large: boolean; keepZoom: boolean; eye: Eye; brightness: number; hintSeen: boolean;
  turn: Turn; speed: Speed; sound: boolean; saver: boolean;
};
const key = "reader-settings";
const defaults: Settings = {
  large: false, keepZoom: true, eye: "normal", brightness: 100, hintSeen: false,
  turn: "curl", speed: "normal", sound: false, saver: false,
};
export const turnMs: Record<Speed, number> = { fast: 300, normal: 520, slow: 820 };

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

/**
 * A soft paper swish, made here rather than shipped as a file: a short burst of low-passed noise.
 * ponytail: one fixed sound; offer a choice only if anyone asks for one.
 */
export function turnSound() {
  const rate = 22050;
  const length = Math.round(rate * 0.32);
  const data = new DataView(new ArrayBuffer(44 + length * 2));
  const text = (at: number, value: string) => [...value].forEach((char, index) => data.setUint8(at + index, char.charCodeAt(0)));
  text(0, "RIFF"); data.setUint32(4, 36 + length * 2, true); text(8, "WAVEfmt ");
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
  data.setUint32(24, rate, true); data.setUint32(28, rate * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
  text(36, "data"); data.setUint32(40, length * 2, true);
  let low = 0;
  for (let index = 0; index < length; index++) {
    const time = index / length;
    low += 0.22 * (Math.random() * 2 - 1 - low);
    const envelope = Math.sin(Math.PI * Math.min(1, time * 1.6)) ** 2 * (1 - time);
    data.setInt16(44 + index * 2, Math.round(low * envelope * 0.9 * 32767), true);
  }
  return URL.createObjectURL(new Blob([data], { type: "audio/wav" }));
}
