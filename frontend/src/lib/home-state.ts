import { api, ApiError } from "./api";

export type Schedule = {
  id: number;
  scheduled_at: string;
  message: string;
  sent: boolean | number;
  discarded: boolean | number;
};

/**
 * 取得するデータの状態。
 * - loading: 取得中
 * - error: 取得に失敗した（error が画面に出す文言）
 * - ready: 取得できた
 * value は最後に取得できた値で、一度も取得できていなければ null。
 * 取り直している間や失敗したときも残すので、「まだ分からない」と「空だった」を value で区別できる。
 */
export type Loadable<T> = {
  status: "loading" | "error" | "ready";
  value: T | null;
  error: string;
};

export function initialLoad<T>(): Loadable<T> {
  return { status: "loading", value: null, error: "" };
}

export function reloading<T>(state: Loadable<T>): Loadable<T> {
  return { status: "loading", value: state.value, error: "" };
}

export function loaded<T>(value: T): Loadable<T> {
  return { status: "ready", value, error: "" };
}

export function failed<T>(state: Loadable<T>, error: string): Loadable<T> {
  return { status: "error", value: state.value, error };
}

/** 取得した予定と、それが何日の分か（端末の日付）。 */
export type TodaySchedules = { day: string; schedules: Schedule[] };

/** 別の日に取得した予定を捨てる。日付が変わった後に、前日の一覧を「今日のお告げ」として出さないため。 */
export function forDay(state: Loadable<TodaySchedules>, day: string): Loadable<TodaySchedules> {
  return state.value && state.value.day !== day ? { ...state, value: null } : state;
}

/** 日付が変わってから、その日の予定を取り直すまでの猶予。0 時に始まる当日分の生成が終わるのを待つ。 */
export const DAY_CHANGE_GRACE_MS = 30_000;

/** 日付が変わったかを確かめる間隔。 */
export const DAY_CHECK_INTERVAL_MS = 60_000;

/** 予定を取得する時点の「今日」（端末の日付）。0 時から DAY_CHANGE_GRACE_MS の間は前日のままにする。 */
export function scheduleDay(now = new Date()) {
  const date = new Date(now.getTime() - DAY_CHANGE_GRACE_MS);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export const INVALID_RESPONSE_MESSAGE = "サーバーから想定外の応答が返りました。";
export const UNEXPECTED_ERROR_MESSAGE = "うまく処理できませんでした。時間をおいてもう一度お試しください。";
export const SUBSCRIPTION_ERROR_MESSAGE =
  "この端末の受け取り状態を確認できませんでした。「更新」でもう一度確認できます。";

export async function fetchTodaySchedules(): Promise<Schedule[]> {
  const data = await api<{ schedules?: unknown } | null>("/api/public/schedules");
  // 成功ステータスでも、プロキシなどが JSON 以外を返すと予定の配列は入っていない。空の一覧として扱わず、失敗にする。
  if (!Array.isArray(data?.schedules)) throw new ApiError(INVALID_RESPONSE_MESSAGE, 200);
  return data.schedules as Schedule[];
}

/** 取得の失敗を画面に出す文言にする。api() 以外から来た例外の文言（ブラウザの英語のメッセージ）は出さない。 */
export function describeLoadError(error: unknown) {
  return error instanceof ApiError ? error.message : UNEXPECTED_ERROR_MESSAGE;
}

export type SubscriptionView = {
  title: string;
  description: string;
  canSubscribe: boolean;
  canUnsubscribe: boolean;
};

/** 購読カードの表示。購読状態が分かるまでは「未設定」と表示しない。 */
export function subscriptionView(state: Loadable<boolean>): SubscriptionView {
  if (state.status === "error") {
    // 状態が分からなくても、受け取りの操作はできるようにしておく（操作の中で改めて確認される）。
    return { title: "確認できません", description: state.error, canSubscribe: true, canUnsubscribe: false };
  }
  if (state.value === null) {
    return {
      title: "確認中",
      description: "この端末の受け取り状態を確認しています。",
      canSubscribe: false,
      canUnsubscribe: false,
    };
  }
  if (state.value) {
    return {
      title: "受け取り中",
      description: "今日のお告げを待機しています。予定は下の一覧で確認できます。",
      canSubscribe: false,
      canUnsubscribe: true,
    };
  }
  return {
    title: "未設定",
    description: "通知を許可すると、今日のどこかでOTSUGEからお告げが届きます。",
    canSubscribe: true,
    canUnsubscribe: false,
  };
}
