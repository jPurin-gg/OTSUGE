import { formatTime } from "./api";

// 管理画面の「取り消せない操作」の確認文をつくる。何が対象で、何が起きるかを確認文に必ず入れる。

type Flag = boolean | number;

export type ConfirmSchedule = {
  scheduled_at: string;
  sent: Flag;
  discarded: Flag;
  manually_modified: Flag;
  message: string;
};

export type ScheduleState = "unsent" | "sent" | "discarded";

/** 配信予定の状態。破棄は sent も立つので、破棄を先に見る。 */
export function scheduleState(schedule: Pick<ConfirmSchedule, "sent" | "discarded">): ScheduleState {
  if (Boolean(schedule.discarded)) return "discarded";
  return Boolean(schedule.sent) ? "sent" : "unsent";
}

const STATE_LABELS: Record<ScheduleState, string> = {
  unsent: "未送信",
  sent: "送信済み",
  discarded: "破棄",
};

export function scheduleStateLabel(schedule: Pick<ConfirmSchedule, "sent" | "discarded">) {
  return STATE_LABELS[scheduleState(schedule)];
}

/** 送信済み・破棄済みの予定を送るのは「再送」。backend には resend: true を付けないと拒否される。 */
export function isResend(schedule: Pick<ConfirmSchedule, "sent" | "discarded">) {
  return scheduleState(schedule) !== "unsent";
}

/** 「18:30「水を飲め」（未送信 / 手動編集）」の形で、予定を特定できる1行にする。 */
function describeSchedule(schedule: ConfirmSchedule) {
  const manual = Boolean(schedule.manually_modified) ? " / 手動編集" : "";
  return `${formatTime(schedule.scheduled_at)}「${schedule.message}」（${scheduleStateLabel(schedule)}${manual}）`;
}

function describeRecipients(subscriptionCount: number) {
  if (subscriptionCount <= 0) return "送信先: 購読は0件です。誰にも届きませんが、この予定は送信済みになります。";
  return `送信先: 購読 ${subscriptionCount}件すべて`;
}

/** 「今すぐ送る」「再送」の確認文。本文・予定時刻・送信先の件数を入れる。 */
export function sendConfirmText(schedule: ConfirmSchedule, subscriptionCount: number) {
  const state = scheduleState(schedule);
  const lead =
    state === "sent"
      ? "【再送】このお告げは送信済みです。再送すると、同じ通知がもう一度届きます。"
      : state === "discarded"
        ? "【再送】このお告げは破棄済みです（予定時刻を過ぎたため、送られなかった予定です）。"
        : "このお告げを今すぐ送ります。";
  return [
    lead,
    "",
    describeSchedule(schedule),
    describeRecipients(subscriptionCount),
    "",
    `送信は取り消せません。${state === "unsent" ? "送りますか？" : "再送しますか？"}`,
  ].join("\n");
}

/**
 * 「今すぐ送る」「再送」の実行。確認に同意したときだけ send を呼ぶ。
 * 送信済み・破棄済みの予定のときだけ resend: true を渡す。同意しなければ false を返す。
 */
export async function confirmAndSend<T>(
  schedule: ConfirmSchedule,
  subscriptionCount: number,
  actions: {
    confirm: (message: string) => boolean;
    send: (options: { resend: boolean }) => Promise<T>;
  },
): Promise<{ sent: true; resend: boolean; result: T } | { sent: false }> {
  if (!actions.confirm(sendConfirmText(schedule, subscriptionCount))) return { sent: false };
  const resend = isResend(schedule);
  return { sent: true, resend, result: await actions.send({ resend }) };
}
