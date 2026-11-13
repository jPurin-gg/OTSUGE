import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Knex } from "knex";
import { chooseMinutes, generateDailySchedules, isQuietMinute } from "./scheduler";
import type { NotificationRecord, QuietHoursRecord, ScheduleRecord } from "./types";

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

const dateKey = "2026-11-13";
const notification: NotificationRecord = {
  id: 1,
  message: "水を飲め",
  start_time: "09:00",
  end_time: "12:00",
  count_per_day: 2,
  min_interval_minutes: 60,
  enabled: true,
  created_at: "2026-11-12T15:00:00.000Z",
  updated_at: "2026-11-12T15:00:00.000Z",
};

function schedule(id: number, time: string, overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id,
    notification_id: notification.id,
    scheduled_at: `${dateKey}T${time}+09:00`,
    sent: false,
    discarded: false,
    manually_modified: false,
    created_at: notification.created_at,
    updated_at: notification.updated_at,
    ...overrides,
  };
}

// Exercise regeneration without opening a real database or loading application env files.
function regenerationDatabase(
  t: TestContext,
  schedules: ScheduleRecord[],
  notifications = [notification],
  quietHours: QuietHoursRecord[] = [],
) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(`${dateKey}T09:30:00+09:00`) });
  t.mock.method(Math, "random", () => 0.5);
  const previousTimezone = process.env.APP_TIMEZONE;
  process.env.APP_TIMEZONE = "Asia/Tokyo";
  t.after(() => {
    if (previousTimezone === undefined) delete process.env.APP_TIMEZONE;
    else process.env.APP_TIMEZONE = previousTimezone;
  });

  const tables = {
    notifications,
    quiet_hours: quietHours,
    schedules: schedules.map((row) => ({ ...row, scheduled_at: new Date(row.scheduled_at).toISOString() })),
  };
  type Row = NotificationRecord | QuietHoursRecord | ScheduleRecord;
  const database = (table: keyof typeof tables) => {
    const predicates: ((row: Row) => boolean)[] = [];
    const matches = (row: Row) => predicates.every((predicate) => predicate(row));
    const query = {
      where(column: string | Record<string, unknown>, operator?: string, value?: string) {
        predicates.push((row) => {
          const fields = row as Record<string, unknown>;
          if (typeof column !== "string") {
            return Object.entries(column).every(([key, expected]) => fields[key] === expected);
          }
          assert.ok(operator === ">=" || operator === "<");
          assert.equal(typeof value, "string");
          const actual = String(fields[column]);
          return operator === ">=" ? actual >= value! : actual < value!;
        });
        return query;
      },
      andWhere(column: string | Record<string, unknown>, operator?: string, value?: string) {
        return query.where(column, operator, value);
      },
      select() {
        return query;
      },
      then(resolve: (rows: Row[]) => unknown) {
        return Promise.resolve(tables[table].filter(matches)).then(resolve);
      },
      async delete() {
        assert.equal(table, "schedules");
        tables.schedules = tables.schedules.filter((row) => !matches(row));
      },
      async insert(rows: Omit<ScheduleRecord, "id">[]) {
        assert.equal(table, "schedules");
        let nextId = Math.max(0, ...tables.schedules.map((row) => row.id)) + 1;
        tables.schedules.push(...rows.map((row) => ({ ...row, id: nextId++ })));
      },
    };
    return query;
  };
  return { database: database as unknown as Knex, tables };
}

test("regeneration counts sent schedules and respects their minimum interval", async (t) => {
  const { database, tables } = regenerationDatabase(t, [
    schedule(1, "09:29:00", { sent: true }),
    schedule(2, "09:40:00"),
  ]);
  const retained = { ...tables.schedules[0] };

  assert.deepEqual(await generateDailySchedules(database, dateKey), { generated: 1, warnings: [], date: dateKey });
  assert.equal(tables.schedules.length, 2);
  assert.deepEqual(tables.schedules.find((row) => row.id === retained.id), retained);
  assert.deepEqual(tables.schedules.filter((row) => !row.sent).map((row) => row.scheduled_at), [
    `${dateKey}T01:29:00.000Z`, // 10:29 Asia/Tokyo
  ]);

  // A second regeneration must replace only the unsent automatic schedule.
  assert.deepEqual(await generateDailySchedules(database, dateKey), { generated: 1, warnings: [], date: dateKey });
  assert.equal(tables.schedules.length, 2);
  assert.deepEqual(tables.schedules.find((row) => row.id === retained.id), retained);
});

test("regeneration adds nothing when retained schedules meet or exceed the daily count", async (t) => {
  for (const count of [2, 3]) {
    await t.test(`${count} retained schedules`, async (t) => {
      const { database, tables } = regenerationDatabase(t, [
        schedule(1, "09:00:00", { sent: true }),
        schedule(2, "10:00:00", { sent: true, manually_modified: true }),
        ...(count === 3 ? [schedule(3, "11:00:00", { manually_modified: true })] : []),
        schedule(4, "11:30:00"),
      ]);
      const retained = tables.schedules.filter((row) => row.sent || row.manually_modified);

      assert.deepEqual(await generateDailySchedules(database, dateKey), { generated: 0, warnings: [], date: dateKey });
      assert.deepEqual(tables.schedules, retained);
    });
  }
});

test("manual schedules remain exempt but occupy count and interval for new automatic schedules", async (t) => {
  const { database, tables } = regenerationDatabase(
    t,
    [
      schedule(1, "09:29:00", { sent: true }),
      schedule(2, "09:30:00", { manually_modified: true }),
      schedule(3, "11:00:00", { manually_modified: true }),
    ],
    [{ ...notification, count_per_day: 4 }],
    [{ id: 1, start_time: "09:00", end_time: "11:30", enabled: true, created_at: notification.created_at, updated_at: notification.updated_at }],
  );
  const retained = tables.schedules.map((row) => ({ ...row }));

  assert.deepEqual(await generateDailySchedules(database, dateKey), { generated: 1, warnings: [], date: dateKey });
  assert.deepEqual(tables.schedules.slice(0, 3), retained);
  assert.equal(tables.schedules.length, 4);
  assert.equal(tables.schedules[3].scheduled_at, `${dateKey}T03:00:00.000Z`); // 12:00 Asia/Tokyo
});

test("retained schedules outside the notification window still occupy their minimum interval", async (t) => {
  const { database, tables } = regenerationDatabase(t, [
    schedule(1, "12:01:00", { manually_modified: true }),
  ], [{ ...notification, min_interval_minutes: 180 }]);
  const retained = [...tables.schedules];

  assert.deepEqual(await generateDailySchedules(database, dateKey), {
    generated: 0,
    warnings: ["「水を飲め」は条件内で0件のみ生成しました。"],
    date: dateKey,
  });
  assert.deepEqual(tables.schedules, retained);
});

test("only schedules of the same notification within the local day occupy slots", async (t) => {
  const { database, tables } = regenerationDatabase(t, [
    schedule(1, "09:29:00", { sent: true }),
    schedule(2, "09:31:00", { notification_id: 2, manually_modified: true }),
    schedule(3, "00:00:00", { scheduled_at: "2026-11-12T23:59:00+09:00", sent: true }),
    schedule(4, "00:00:00", { scheduled_at: "2026-11-14T00:00:00+09:00", manually_modified: true }),
    schedule(5, "09:40:00"),
  ], [notification, { ...notification, id: 2, count_per_day: 1 }]);
  const retained = tables.schedules.filter((row) => row.id !== 5);

  assert.deepEqual(await generateDailySchedules(database, dateKey), { generated: 1, warnings: [], date: dateKey });
  assert.deepEqual(tables.schedules.slice(0, 4), retained);
  assert.equal(tables.schedules.length, 5);
  assert.equal(tables.schedules[4].notification_id, 1);
  assert.equal(tables.schedules[4].scheduled_at, `${dateKey}T01:29:00.000Z`);
});

test("automatic schedules respect seconds and milliseconds in retained times", async (t) => {
  const { database, tables } = regenerationDatabase(t, [
    schedule(1, "09:29:30.500", { manually_modified: true }),
  ]);

  assert.deepEqual(await generateDailySchedules(database, dateKey), { generated: 1, warnings: [], date: dateKey });
  assert.equal(tables.schedules[1].scheduled_at, `${dateKey}T01:30:00.000Z`); // 10:30 Asia/Tokyo
});
