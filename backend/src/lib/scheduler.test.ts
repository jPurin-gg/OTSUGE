import assert from "node:assert/strict";
import test from "node:test";
import { chooseMinutes, isQuietMinute } from "./scheduler";

test("quiet hours can cross midnight", () => {
  const quiet = [{ start_time: "22:00", end_time: "08:00", enabled: true }];
  assert.equal(isQuietMinute(23 * 60, quiet), true);
  assert.equal(isQuietMinute(7 * 60, quiet), true);
  assert.equal(isQuietMinute(12 * 60, quiet), false);
});

test("generated times respect count, quiet hours, and minimum interval", () => {
  const selected = chooseMinutes(
    { start_time: "09:00", end_time: "12:00", count_per_day: 3, min_interval_minutes: 60 },
    [{ start_time: "10:00", end_time: "10:30", enabled: true }],
    () => 0.5,
  );
  assert.equal(selected.length, 3);
  assert.ok(selected.every((minute) => minute < 600 || minute >= 630));
  assert.ok(selected.slice(1).every((minute, index) => minute - selected[index] >= 60));
});
