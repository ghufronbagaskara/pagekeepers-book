import type { ReadingClock } from "./sessions";
import { todayMs } from "./sessions";
import { duration, goalMinutes } from "./stats";

const element = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
const clockFace = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** A countdown over time the book is on screen: it pauses when the reader switches away. */
export function setupTimer(clock: ReadingClock, uid: string, page: () => number, leave: () => void) {
  const button = element<HTMLButtonElement>("timer");
  const pill = element("timer-pill");
  const setup = element<HTMLDialogElement>("timer-dialog");
  const minutes = element<HTMLInputElement>("timer-minutes");
  const done = element<HTMLDialogElement>("timer-done");
  let run: { endAt: number; length: number; fromPage: number } | undefined;
  let audio: AudioContext | undefined;
  let wake: WakeLockSentinel | undefined;

  const holdScreen = async () => {
    if (!run || document.hidden || wake) return;
    try {
      wake = await navigator.wakeLock?.request("screen");
      wake?.addEventListener("release", () => { wake = undefined; }, { once: true });
    } catch {}
  };
  const render = () => {
    pill.hidden = !run;
    button.setAttribute("aria-pressed", String(Boolean(run)));
    const label = run ? `Timer membaca, sisa ${clockFace(run.endAt - clock.visibleMs)}` : "Timer membaca";
    button.setAttribute("aria-label", label);
    button.title = label;
    if (run) pill.textContent = clockFace(run.endAt - clock.visibleMs);
  };
  const start = (length: number) => {
    run = { endAt: clock.visibleMs + length, length, fromPage: page() };
    clock.touch();
    void holdScreen();
    render();
  };
  const stop = () => {
    run = undefined;
    void wake?.release().catch(() => {});
    render();
  };
  const chime = () => {
    if (!audio) return;
    for (const [index, pitch] of [660, 880].entries()) {
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      const at = audio.currentTime + index * 0.22;
      tone.frequency.value = pitch;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.6);
      tone.connect(gain).connect(audio.destination);
      tone.start(at);
      tone.stop(at + 0.65);
    }
  };
  const finish = async () => {
    const finished = run!;
    stop();
    chime();
    navigator.vibrate?.(200);
    await clock.save();
    const today = await todayMs(uid);
    const goal = goalMinutes(uid);
    const to = page();
    const pages = to === finished.fromPage ? `di halaman ${to}` : `dari halaman ${finished.fromPage} sampai ${to}`;
    const progress = today >= goal * 60000 ? `Target hari ini (${goal} menit) tercapai, total ${duration(today)}.` :
      `Hari ini: ${duration(today)} dari target ${goal} menit.`;
    element("timer-done-message").textContent = `Anda sudah membaca ${duration(finished.length)}, ${pages}. ${progress}`;
    done.returnValue = "";
    done.showModal();
  };

  clock.onTick = () => {
    if (!run) return;
    if (clock.visibleMs >= run.endAt) void finish();
    else render();
  };
  document.addEventListener("visibilitychange", () => void holdScreen());
  button.addEventListener("click", () => {
    element("timer-stop").hidden = !run;
    setup.returnValue = "";
    setup.showModal();
  });
  setup.addEventListener("close", () => {
    const choice = setup.returnValue;
    if (choice === "stop") return stop();
    const length = choice === "start" ? minutes.valueAsNumber : Number(choice);
    if (!Number.isFinite(length) || length < 1) return;
    // Created on this click so the browser lets it play when the time is up.
    audio ??= window.AudioContext ? new AudioContext() : undefined;
    void audio?.resume().catch(() => {});
    start(Math.min(length, 240) * 60000);
  });
  done.addEventListener("close", () => {
    if (done.returnValue === "extend") start(5 * 60000);
    else if (done.returnValue === "library") leave();
  });
  render();
}
