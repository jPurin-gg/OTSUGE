import assert from "node:assert/strict";
import test from "node:test";
import type { Knex } from "knex";
import { chooseMinutes, generateDailySchedules, isQuietMinute } from "./scheduler";
import { localMinuteOfDay, timeFromMinutes } from "./time";
import type { ScheduleRecord } from "./types";

function seededRandom(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function assertSchedule(selected: number[], count: number, candidates: number[], interval: number) {
  assert.equal(selected.length, count);
  assert.equal(new Set(selected).size, count);
  assert.ok(selected.every((minute) => candidates.includes(minute)));
  assert.ok(selected.slice(1).every((minute, index) => minute - selected[index] >= interval));
}

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

test("tight schedules retain both endpoints regardless of the random seed", () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const selected = chooseMinutes(
      { start_time: "09:00", end_time: "11:00", count_per_day: 2, min_interval_minutes: 120 },
      [],
      seededRandom(seed),
    );
    assert.deepEqual(selected, [540, 660], `seed=${seed}`);
  }
});

test("tight schedules retain the requested count across separate allowed windows", () => {
  const quietHours = [
    { start_time: "09:01", end_time: "10:00", enabled: true },
    { start_time: "11:01", end_time: "12:00", enabled: true },
  ];
  for (let seed = 1; seed <= 100; seed += 1) {
    const selected = chooseMinutes(
      { start_time: "09:00", end_time: "13:00", count_per_day: 5, min_interval_minutes: 60 },
      quietHours,
      seededRandom(seed),
    );
    assert.deepEqual(selected, [540, 600, 660, 720, 780], `seed=${seed}`);
  }
});

test("flexible schedules vary with randomness and reproduce the same seed", () => {
  const notification = { start_time: "09:00", end_time: "12:00", count_per_day: 3, min_interval_minutes: 60 };
  const first = chooseMinutes(notification, [], () => 0);
  const last = chooseMinutes(notification, [], () => 1 - Number.EPSILON);
  const candidates = Array.from({ length: 181 }, (_, index) => 540 + index);
  assertSchedule(first, 3, candidates, 60);
  assertSchedule(last, 3, candidates, 60);
  assert.notDeepEqual(first, last);
  assert.deepEqual(
    chooseMinutes(notification, [], seededRandom(1)),
    chooseMinutes(notification, [], seededRandom(1)),
  );
});

test("remaining time limits still allow the maximum safe partial schedule", () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const selected = chooseMinutes(
      { start_time: "09:00", end_time: "11:00", count_per_day: 3, min_interval_minutes: 60 },
      [],
      seededRandom(seed),
      10 * 60,
    );
    assert.deepEqual(selected, [600, 660], `seed=${seed}`);
  }
});

test("selection matches exhaustive feasibility for every small candidate set", () => {
  const minutes = Array.from({ length: 6 }, (_, index) => 540 + index);
  for (let mask = 0; mask < 2 ** minutes.length; mask += 1) {
    const candidates = minutes.filter((_, index) => mask & (1 << index));
    const quietHours = minutes.filter((minute) => !candidates.includes(minute)).map((minute) => ({
      start_time: timeFromMinutes(minute),
      end_time: timeFromMinutes(minute + 1),
      enabled: true,
    }));
    for (let interval = 0; interval <= 6; interval += 1) {
      let maximum = 0;
      for (let subset = 0; subset < 2 ** candidates.length; subset += 1) {
        const selected = candidates.filter((_, index) => subset & (1 << index));
        if (selected.slice(1).every((minute, index) => minute - selected[index] >= interval)) {
          maximum = Math.max(maximum, selected.length);
        }
      }
      for (let count = 1; count <= 7; count += 1) {
        for (const random of [() => 0, () => 0.5, () => 1 - Number.EPSILON, seededRandom(1)]) {
          const selected = chooseMinutes(
            { start_time: "09:00", end_time: "09:05", count_per_day: count, min_interval_minutes: interval },
            quietHours,
            random,
          );
          assertSchedule(selected, Math.min(count, maximum), candidates, interval);
        }
      }
    }
  }
});

test("daily generation warns only for shortages and persists safe partial results", async (context) => {
  context.mock.method(Math, "random", () => 0.5);
  const dateKey = "2000-01-01";
  for (const { count, quietHours, expectedMinutes } of [
    { count: 2, quietHours: [], expectedMinutes: [540, 660] },
    { count: 3, quietHours: [], expectedMinutes: [540, 660] },
    { count: 3, quietHours: [{ start_time: "00:00", end_time: "00:00", enabled: true }], expectedMinutes: [] },
  ]) {
    const notification = {
      id: 1,
      message: "水を飲め",
      start_time: "09:00",
      end_time: "11:00",
      count_per_day: count,
      min_interval_minutes: 120,
    };
    const inserted: Omit<ScheduleRecord, "id">[] = [];
    const database = ((table: string) => {
      if (table === "notifications") return { where: async () => [notification] };
      if (table === "quiet_hours") return { where: async () => quietHours };
      assert.equal(table, "schedules");
      return {
        where() { return this; },
        andWhere() { return this; },
        delete: async () => 0,
        insert: async (rows: typeof inserted) => { inserted.push(...rows); },
      };
    }) as unknown as Knex;

    const result = await generateDailySchedules(database, dateKey);
    assert.deepEqual(result, {
      generated: expectedMinutes.length,
      warnings: expectedMinutes.length < count
        ? [`「水を飲め」は条件内で${expectedMinutes.length}件のみ生成しました。`]
        : [],
      date: dateKey,
    });
    assert.deepEqual(inserted.map((row) => localMinuteOfDay(new Date(row.scheduled_at))), expectedMinutes);
    assert.ok(inserted.every((row) => row.notification_id === notification.id && !row.sent && !row.manually_modified));
  }
});
