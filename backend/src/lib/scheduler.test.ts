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

test("notification end time 00:00 means end of day", () => {
  const selected = chooseMinutes(
    { start_time: "09:00", end_time: "00:00", count_per_day: 5, min_interval_minutes: 60 },
    [],
    () => 0.5,
  );
  assert.equal(selected.length, 5);
  assert.ok(selected.every((minute) => minute >= 9 * 60 && minute <= 23 * 60 + 59));
});

test("generation can be limited to minutes after the current time", () => {
  const selected = chooseMinutes(
    { start_time: "09:00", end_time: "00:00", count_per_day: 5, min_interval_minutes: 60 },
    [],
    () => 0.5,
    18 * 60 + 31,
  );
  assert.equal(selected.length, 5);
  assert.ok(selected.every((minute) => minute >= 18 * 60 + 31));
});

test("generation ignores requested count when remaining slots are insufficient", () => {
  const selected = chooseMinutes(
    { start_time: "23:50", end_time: "00:00", count_per_day: 5, min_interval_minutes: 10 },
    [],
    () => 0.5,
  );
  assert.ok(selected.length < 5);
  assert.ok(selected.length > 0);
  assert.ok(selected.slice(1).every((minute, index) => minute - selected[index] >= 10));
});
