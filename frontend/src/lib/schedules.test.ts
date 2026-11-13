import assert from "node:assert/strict";
import test from "node:test";
import { loadLastSchedules, parseSchedules, saveLastSchedules, Schedule } from "./schedules";

const schedules: Schedule[] = [
  { id: 1, scheduled_at: "2026-11-14T00:30:00.000Z", message: "水を飲もう", sent: 1, discarded: 0 },
  { id: 2, scheduled_at: "2026-11-14T09:00:00.000Z", message: "背伸びをしよう", sent: false, discarded: false },
];

function memoryStorage(initial?: string) {
  const items = new Map<string, string>();
  if (initial !== undefined) items.set("otsuge:last-schedules", initial);
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

test("parseSchedules() accepts the list returned by /api/public/schedules", () => {
  assert.deepEqual(parseSchedules(schedules), schedules);
  assert.deepEqual(parseSchedules([]), []);
});

test("parseSchedules() rejects values the page cannot render", () => {
  assert.equal(parseSchedules(undefined), null); // HTML を {} として受け取ったときの data.schedules
  assert.equal(parseSchedules({}), null);
  assert.equal(parseSchedules([null]), null);
  assert.equal(parseSchedules([{ id: 1, scheduled_at: "not a date", message: "x" }]), null);
  assert.equal(parseSchedules([{ id: 1, scheduled_at: "2026-11-14T00:30:00.000Z" }]), null);
});

test("the last fetched schedules can be read back with the time they were fetched", () => {
  const storage = memoryStorage();
  saveLastSchedules(schedules, new Date("2026-11-14T08:15:00.000Z"), storage);
  assert.deepEqual(loadLastSchedules(storage), { fetchedAt: "2026-11-14T08:15:00.000Z", schedules });
});

test("loadLastSchedules() returns null when nothing usable is stored", () => {
  assert.equal(loadLastSchedules(memoryStorage()), null);
  assert.equal(loadLastSchedules(memoryStorage("{broken")), null);
  assert.equal(loadLastSchedules(memoryStorage(JSON.stringify({ fetchedAt: "2026-11-14T08:15:00.000Z" }))), null);
  assert.equal(loadLastSchedules(memoryStorage(JSON.stringify({ fetchedAt: "?", schedules }))), null);
  assert.equal(loadLastSchedules(memoryStorage(JSON.stringify({ fetchedAt: "2026-11-14T08:15:00.000Z", schedules: [{}] }))), null);
  assert.equal(loadLastSchedules(null), null);
});

test("storage failures do not throw", () => {
  const failing = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  saveLastSchedules(schedules, new Date(), failing);
  assert.equal(loadLastSchedules(failing), null);
});
