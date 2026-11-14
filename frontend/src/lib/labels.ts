// 画面に出す文言の対応表（issue #26）。
// - 予定の状態は全画面で「未送信」「送信済み」と呼ぶ。
// - 対象の呼び方は、利用者向けホームでは「お告げ」、管理画面では「配信予定」。
// - 「通知」は Push 通知そのものを指すときだけ使う。
// - 時間切れで送らなかった予定は、管理画面では仕様書の用語どおり「破棄」、
//   利用者向けホームでは内部用語を出さず「送信なし」と呼ぶ。

export type ScheduleStatus = "pending" | "sent" | "discarded";

type Flag = boolean | number;

export function scheduleStatus(schedule: { sent: Flag; discarded: Flag }): ScheduleStatus {
  if (!Boolean(schedule.sent)) return "pending";
  return Boolean(schedule.discarded) ? "discarded" : "sent";
}

/** 利用者向けホームでの状態の呼び方。 */
export const HOME_STATUS_LABELS: Record<ScheduleStatus, string> = {
  pending: "未送信",
  sent: "送信済み",
  discarded: "送信なし",
};

/** 管理画面での状態の呼び方。 */
export const ADMIN_STATUS_LABELS: Record<ScheduleStatus, string> = {
  pending: "未送信",
  sent: "送信済み",
  discarded: "破棄",
};
