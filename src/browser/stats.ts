import { t } from "./i18n";

export type Timed = { startedAt: number; activeMs: number };

const pad = (value: number) => String(value).padStart(2, "0");
export const dayKey = (time: number) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
// ponytail: a session counts toward the day it started; split sessions at midnight if late readers complain.
export function byDay(sessions: Timed[]) {
  const days = new Map<string, number>();
  for (const { startedAt, activeMs } of sessions) days.set(dayKey(startedAt), (days.get(dayKey(startedAt)) ?? 0) + activeMs);
  return days;
}
export function daysBack(count: number, now = Date.now()) {
  const date = new Date(now);
  date.setHours(12, 0, 0, 0);
  return Array.from({ length: count }, () => {
    const time = date.getTime();
    date.setDate(date.getDate() - 1);
    return time;
  });
}
// Days in a row that met the goal. Today only extends the streak; an unfinished today never breaks it.
export function streak(days: Map<string, number>, goalMs: number, now = Date.now()) {
  let count = 0;
  for (const [index, day] of daysBack(4000, now).entries()) {
    if ((days.get(dayKey(day)) ?? 0) >= goalMs) count++;
    else if (index > 0) break;
  }
  return count;
}
export function duration(ms: number) {
  const minutes = Math.floor(ms / 60000);
  return minutes < 60 ? t("{minutes} min", { minutes }) : t("{hours} h {minutes} min", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}
const goalKey = (uid: string) => `reading-goal/${uid}`;
export const goalMinutes = (uid: string) => Number(localStorage.getItem(goalKey(uid))) || 15;
export const setGoalMinutes = (uid: string, minutes: number) => localStorage.setItem(goalKey(uid), String(minutes));
