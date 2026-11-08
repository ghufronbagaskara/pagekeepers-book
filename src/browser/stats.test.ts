import { test, expect } from "bun:test";
import { byDay, dayKey, daysBack, duration, streak } from "./stats";

test("streak counts goal days in a row and an unfinished today does not break it", () => {
  const now = new Date(2026, 10, 8, 21, 0).getTime();
  const [today, yesterday, twoAgo, threeAgo, fourAgo] = daysBack(5, now) as [number, number, number, number, number];
  const minute = 60000;
  const days = byDay([
    { startedAt: yesterday, activeMs: 10 * minute },
    { startedAt: yesterday + 1000, activeMs: 6 * minute },
    { startedAt: twoAgo, activeMs: 15 * minute },
    { startedAt: threeAgo, activeMs: 14 * minute },
    { startedAt: fourAgo, activeMs: 99 * minute },
  ]);
  expect(days.get(dayKey(yesterday))).toBe(16 * minute);
  expect(streak(days, 15 * minute, now)).toBe(2);
  days.set(dayKey(today), 20 * minute);
  expect(streak(days, 15 * minute, now)).toBe(3);
  expect(streak(new Map(), 15 * minute, now)).toBe(0);
  expect(duration(59 * minute + 59000)).toBe("59 min");
  expect(duration(80 * minute)).toBe("1 h 20 min");
});
