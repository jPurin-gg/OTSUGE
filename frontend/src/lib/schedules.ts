export type Schedule = {
  id: number;
  scheduled_at: string;
  message: string;
  sent: boolean | number;
  discarded: boolean | number;
};

export type LastSchedules = {
  /** 取得できた時刻（ISO 8601）。 */
  fetchedAt: string;
  schedules: Schedule[];
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const STORAGE_KEY = "otsuge:last-schedules";

function isDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isSchedule(value: unknown): value is Schedule {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "number" && isDateString(item.scheduled_at) && typeof item.message === "string";
}

/** 予定の一覧として画面に出せる形か確かめる。出せない形なら null（そのまま描画すると例外になる）。 */
export function parseSchedules(value: unknown): Schedule[] | null {
  return Array.isArray(value) && value.every(isSchedule) ? value : null;
}

function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 最後に取得できた予定を端末に残す。オフライン時の表示に使う。保存できなくても表示は続ける。 */
export function saveLastSchedules(schedules: Schedule[], now: Date = new Date(), storage = browserStorage()) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ fetchedAt: now.toISOString(), schedules }));
  } catch {
    // 容量不足やプライベートブラウズでは保存できない。
  }
}

/** 端末に残した予定を読む。ない・壊れている・形が違うときは null。 */
export function loadLastSchedules(storage = browserStorage()): LastSchedules | null {
  try {
    const stored = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null");
    const schedules = parseSchedules(stored?.schedules);
    if (!schedules || !isDateString(stored.fetchedAt)) return null;
    return { fetchedAt: stored.fetchedAt, schedules };
  } catch {
    return null;
  }
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
