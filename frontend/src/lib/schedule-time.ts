/** 時刻欄の判定に使う配信予定の項目。 */
export type ScheduleTimeTarget = {
  scheduled_at: string;
  sent: boolean | number;
  discarded: boolean | number;
};

const MINUTE = 60_000;
/** backend の配信処理は、予定時刻からこの時間以上過ぎた未送信の予定を破棄する。 */
const DISCARD_AFTER = 30 * MINUTE;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** 配信予定の時刻を `<input type="time">` の値（端末のタイムゾーンの HH:MM）にする。 */
export function toTimeInputValue(scheduledAt: string) {
  const date = new Date(scheduledAt);
  if (Number.isNaN(date.getTime())) return "";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 送信済み・破棄済みの予定は時刻を変更できない（破棄は sent も立つが、表示と同じ2項目で判定する）。 */
export function isScheduleLocked(schedule: Pick<ScheduleTimeTarget, "sent" | "discarded">) {
  return Boolean(schedule.sent) || Boolean(schedule.discarded);
}

export type ScheduleTimeChange =
  /** 時刻が変わっていない。保存しない。 */
  | { kind: "unchanged" }
  /** 空、または時刻として読めない。保存しない。 */
  | { kind: "invalid" }
  | {
      kind: "change";
      /** 送信する値（ISO 8601、UTC）。日付は元の予定のまま。 */
      scheduledAt: string;
      /** 現在より前の時刻にしたときに次の配信処理で起きること。未来の時刻なら null。 */
      pastEffect: "send" | "discard" | null;
    };

/**
 * 時刻欄の値から、保存する内容を決める。日付は元の予定の日付に固定し、時と分だけを入れ替える。
 */
export function planScheduleTimeChange(currentScheduledAt: string, value: string, now = new Date()): ScheduleTimeChange {
  const current = new Date(currentScheduledAt);
  const match = TIME_PATTERN.exec(value);
  if (!match || Number.isNaN(current.getTime())) return { kind: "invalid" };

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour === current.getHours() && minute === current.getMinutes()) return { kind: "unchanged" };

  const next = new Date(current.getFullYear(), current.getMonth(), current.getDate(), hour, minute);
  return { kind: "change", scheduledAt: next.toISOString(), pastEffect: pastEffectOf(next, now) };
}

function pastEffectOf(next: Date, now: Date): "send" | "discard" | null {
  if (next.getTime() > now.getTime()) return null;
  // 配信処理は毎分0秒に動く。次の実行時点で30分以上過ぎている予定は、送信されずに破棄される。
  const nextDispatch = (Math.floor(now.getTime() / MINUTE) + 1) * MINUTE;
  return next.getTime() <= nextDispatch - DISCARD_AFTER ? "discard" : "send";
}

/** 現在より前の時刻にするときの確認文。 */
export function pastTimeConfirmMessage(value: string, pastEffect: "send" | "discard") {
  const time = value.slice(0, 5);
  if (pastEffect === "discard") {
    return `${time} は現在より30分以上前の時刻です。変更すると、この予定は送信されずに破棄されます。変更しますか？`;
  }
  return `${time} は現在より前の時刻です。変更すると、この予定は次の配信処理（1分以内）で送信されます。変更しますか？`;
}

export type ScheduleTimeCommitResult = "unchanged" | "invalid" | "locked" | "cancelled" | "saved";

/**
 * 時刻欄の確定（フォーカスを外したとき）の処理。値が変わっていて、時刻として正しく、
 * 過去の時刻なら確認に同意したときだけ save を呼ぶ。save の失敗はそのまま投げる。
 */
export async function commitScheduleTime(
  schedule: ScheduleTimeTarget,
  value: string,
  actions: {
    confirm: (message: string) => boolean;
    save: (scheduledAt: string) => Promise<unknown>;
    now?: Date;
  },
): Promise<ScheduleTimeCommitResult> {
  if (isScheduleLocked(schedule)) return "locked";
  const change = planScheduleTimeChange(schedule.scheduled_at, value, actions.now);
  if (change.kind !== "change") return change.kind;
  if (change.pastEffect && !actions.confirm(pastTimeConfirmMessage(value, change.pastEffect))) return "cancelled";
  await actions.save(change.scheduledAt);
  return "saved";
}
