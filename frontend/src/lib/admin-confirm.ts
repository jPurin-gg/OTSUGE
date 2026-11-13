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

export type ConfirmNotification = {
  id: number;
  message: string;
  start_time: string;
  end_time: string;
  count_per_day: number;
  enabled: Flag;
};

export type ConfirmQuietHour = {
  start_time: string;
  end_time: string;
  enabled: Flag;
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

/**
 * 当日の予定を引き直すときに削除される予定。backend の生成処理と同じ条件
 * （未送信かつ手動編集でない）で数える。
 */
export function countRegeneration(schedules: Pick<ConfirmSchedule, "sent" | "discarded" | "manually_modified">[]) {
  let deleted = 0;
  let keptDone = 0;
  let keptManual = 0;
  for (const schedule of schedules) {
    if (scheduleState(schedule) !== "unsent") keptDone += 1;
    else if (Boolean(schedule.manually_modified)) keptManual += 1;
    else deleted += 1;
  }
  return { deleted, keptDone, keptManual };
}

/** 「今日の予定を引き直す」の確認文。削除される予定の件数と、残る予定を入れる。 */
export function regenerateConfirmText(schedules: Pick<ConfirmSchedule, "sent" | "discarded" | "manually_modified">[]) {
  const { deleted, keptDone, keptManual } = countRegeneration(schedules);
  const kept = [
    keptDone > 0 ? `送信済み・破棄済みの予定 ${keptDone}件` : "",
    keptManual > 0 ? `手動編集した未送信の予定 ${keptManual}件` : "",
  ].filter(Boolean);
  return [
    "今日の配信予定を引き直します。",
    "",
    deleted > 0
      ? `・未送信の予定 ${deleted}件を削除し、現在時刻より後の時刻で新しくつくり直します。`
      : "・削除される予定はありません（未送信で手動編集していない予定は0件です）。現在時刻より後の時刻で新しく予定をつくります。",
    ...(kept.length > 0 ? [`・${kept.join("と、")}は残ります。`] : []),
    "",
    deleted > 0 ? "削除した予定は元に戻せません。引き直しますか？" : "つくった予定は自動で配信されます。実行しますか？",
  ].join("\n");
}

/**
 * お告げの削除の確認文。お告げを削除すると、そのお告げの配信予定も一緒に消える。
 * todaysSchedules には画面に出ている当日の予定（全お告げ分）を渡す。
 */
export function deleteNotificationConfirmText(
  notification: ConfirmNotification,
  todaysSchedules: (Pick<ConfirmSchedule, "sent" | "discarded"> & { notification_id: number })[],
) {
  const own = todaysSchedules.filter((schedule) => schedule.notification_id === notification.id);
  const unsent = own.filter((schedule) => scheduleState(schedule) === "unsent").length;
  const impact =
    own.length > 0
      ? `このお告げの配信予定も一緒に消えます（今日の予定 ${own.length}件、うち未送信 ${unsent}件）。`
      : "このお告げの配信予定も一緒に消えます（今日の予定はありません）。";
  return [
    "お告げを削除します。",
    "",
    `「${notification.message}」`,
    `${notification.start_time}-${notification.end_time} / 1日${notification.count_per_day}回 / ${Boolean(notification.enabled) ? "有効" : "無効"}`,
    "",
    impact,
    unsent > 0 ? "未送信の予定は送信されなくなります。送信ログは残ります。" : "送信ログは残ります。",
    "",
    "削除は取り消せません。削除しますか？",
  ].join("\n");
}

/** 配信予定の削除の確認文。 */
export function deleteScheduleConfirmText(schedule: ConfirmSchedule) {
  return [
    "配信予定を削除します。",
    "",
    describeSchedule(schedule),
    "",
    scheduleState(schedule) === "unsent"
      ? "削除すると、この予定は送信されません。"
      : "今日の配信予定の一覧から消えます。送信ログは残ります。",
    "",
    "削除は取り消せません。削除しますか？",
  ].join("\n");
}

/** 静かにする時間の削除の確認文。 */
export function deleteQuietHourConfirmText(quiet: ConfirmQuietHour) {
  const enabled = Boolean(quiet.enabled);
  return [
    "静かにする時間を削除します。",
    "",
    `${quiet.start_time}-${quiet.end_time}（${enabled ? "有効" : "無効"}）`,
    "",
    enabled
      ? "すでにある配信予定は変わりません。次に予定をつくるときから、この時間帯にも配信時刻が入るようになります。"
      : "無効の設定なので、削除しても配信時刻の決まり方は変わりません。",
    "",
    "削除は取り消せません。削除しますか？",
  ].join("\n");
}
