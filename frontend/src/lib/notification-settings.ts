// 管理画面の「お告げ」と「静かにする時間」の設定まわりの判定と文言。
// 画面（frontend/src/app/admin/page.tsx）から使う。React に依存しない。

type TimeRange = {
  start_time: string;
  end_time: string;
};

type NotificationSettings = TimeRange & {
  message: string;
  count_per_day: number;
  min_interval_minutes: number;
  enabled: boolean | number;
};

type NotificationRow = NotificationSettings & { id: number };

type ScheduleRow = {
  notification_id: number;
  sent: boolean | number;
  manually_modified: boolean | number;
};

/** お告げの「終了」の入力欄のそばに出す説明。 */
export const END_TIME_HINT = "00:00 にすると「23:59 まで」になります。";

/** 静かにする時間の入力欄のそばに出す説明。お告げの時間帯と違い、日またぎと終日がある。 */
export const QUIET_HOURS_HINT =
  "開始が終了より後なら日をまたぐ時間帯（例: 22:00〜08:00）、開始と終了が同じなら終日になります。";

function minutesFromTime(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

/** backend の生成処理と同じく、終了 00:00 は「23:59 まで」として扱う。 */
function notificationEndMinute(endTime: string) {
  return endTime === "00:00" ? 23 * 60 + 59 : minutesFromTime(endTime);
}

/**
 * お告げの時間帯が保存できないときの理由を返す（保存できるなら null）。
 * 開始が終了より後だと1件も生成されないので、backend も同じ条件で保存を断る。
 */
export function notificationTimeError(range: TimeRange): string | null {
  if (!range.start_time || !range.end_time) return "開始と終了の時刻を入れてください。";
  if (minutesFromTime(range.start_time) <= notificationEndMinute(range.end_time)) return null;
  return "開始は終了より前の時刻にしてください。日をまたぐ時間帯（例: 22:00〜06:00）は設定できません。夜の終わりまで届けるには、終了を 00:00（23:59 まで）にしてください。";
}

/** 開始と終了が同じ「静かにする時間」は、終日が禁止時間帯になる。 */
export function isAllDayQuietHours(range: TimeRange) {
  return Boolean(range.start_time) && range.start_time === range.end_time;
}

export function allDayQuietHoursConfirmText(range: TimeRange) {
  return [
    `開始と終了が同じ時刻（${range.start_time}）です。`,
    "この設定が有効な間は、終日が「静かにする時間」になり、すべてのお告げが生成されなくなります。",
    "このまま保存しますか？",
  ].join("\n");
}

export type TodayStatus = {
  /** 当日の予定の件数（送信済み・破棄・未送信を含む）。 */
  total: number;
  /** 当日の未送信の件数。 */
  pending: number;
  /** warn: 有効なのに設定回数に満たない。muted: 無効で配信しない。 */
  tone: "ok" | "warn" | "muted";
  text: string;
};

/**
 * お告げ一覧に出す「今日 0 / 3 件」の表示。自動生成で足りなかったお告げが、画面を開けば分かるようにする。
 * 原因が設定から分かる場合（開始が終了より後、静かにする時間が終日）は、その理由を添える。
 */
export function todayStatus(
  item: NotificationRow,
  schedules: ScheduleRow[],
  quietHours: (TimeRange & { enabled: boolean | number })[] = [],
): TodayStatus {
  const own = schedules.filter((schedule) => schedule.notification_id === item.id);
  const total = own.length;
  const pending = own.filter((schedule) => !Boolean(schedule.sent)).length;
  const counts = `今日 ${total} / ${item.count_per_day} 件`;

  if (!Boolean(item.enabled)) {
    const text = pending > 0 ? `無効（今日の未送信 ${pending} 件は送りません）` : "無効（配信しません）";
    return { total, pending, tone: "muted", text };
  }
  if (total >= item.count_per_day) return { total, pending, tone: "ok", text: counts };
  const reason = notificationTimeError(item)
    ? "開始が終了より後のため生成されません。時刻を直してください"
    : quietHours.some((quiet) => Boolean(quiet.enabled) && isAllDayQuietHours(quiet))
      ? "静かにする時間が終日のため生成されません"
      : "設定回数に足りません";
  return { total, pending, tone: "warn", text: `${counts}（${reason}）` };
}
