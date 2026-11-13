/**
 * 購読カードの状態判定と、状態ごとの文言。
 * ブラウザの API には触れない純関数だけを置く（端末の状態を読むのは push.ts の readPushEnvironment）。
 */

/** 端末・ブラウザから読み取った、通知まわりの状態。 */
export type PushEnvironment = {
  /** iPhone / iPad か。 */
  ios: boolean;
  /** ホーム画面に追加したアプリとして開かれているか。 */
  standalone: boolean;
  /** HTTPS（または localhost）で開かれているか。そうでないと Service Worker が使えない。 */
  secure: boolean;
  /** Service Worker / Push API / Notification API がそろっているか。 */
  supported: boolean;
  /** 通知の許可状態。default は「まだ選んでいない（ダイアログを閉じただけを含む）」。 */
  permission: "default" | "granted" | "denied";
  /** この端末に購読があるか。 */
  subscribed: boolean;
};

/**
 * 購読カードの状態。
 * - checking: 端末の状態を読む前
 * - needs-install: iOS で、ホーム画面に追加したアプリとして開かれていない
 * - unsupported: 通知に必要な API がない
 * - blocked: 通知がブロックされている（permission が denied）
 * - unsubscribed: 購読できるが、まだしていない
 * - subscribed: 購読中
 */
export type PushCardState = "checking" | "needs-install" | "unsupported" | "blocked" | "unsubscribed" | "subscribed";

export type PushCardView = {
  state: PushCardState;
  heading: string;
  description: string;
  /** 利用者にやってもらう手順。なければ空。 */
  steps: string[];
  /** 手順の補足。なければ空文字。 */
  note: string;
};

export function isIos({ userAgent, maxTouchPoints }: { userAgent: string; maxTouchPoints: number }) {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  // iPadOS 13 以降の Safari は Mac と同じ UA を名乗る。タッチ操作できる「Mac」は iPad とみなす。
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

export function getPushCardState(env: PushEnvironment | null): PushCardState {
  if (!env) return "checking";
  // iOS はホーム画面に追加したアプリでしか Push API を使えない。API の有無より先に判定し、
  // Safari のタブで開いたときに「非対応」ではなく追加の手順を出す。
  if (env.ios && !env.standalone) return "needs-install";
  if (!env.supported) return "unsupported";
  // ブロック中は購読が残っていても通知を表示できないので、購読の有無より先に判定する。
  if (env.permission === "denied") return "blocked";
  return env.subscribed ? "subscribed" : "unsubscribed";
}

export const SUPPORTED_ENVIRONMENTS =
  "対応環境: iPhone / iPad は iOS 16.4 以上（Safari でホーム画面に追加して開く）、Android / PC は最新の Chrome・Edge・Firefox・Safari。";

function describeUnsupported(env: PushEnvironment): Pick<PushCardView, "heading" | "description" | "note"> {
  if (!env.secure) {
    return {
      heading: "通知に非対応",
      description: "通知は HTTPS で開いたときだけ使えます。https:// で始まるアドレスから開き直してください。",
      note: "",
    };
  }
  if (env.ios) {
    return {
      heading: "通知に非対応",
      description:
        "この端末の iOS では通知を使えません。iPhone / iPad で通知を受け取るには iOS 16.4 以上が必要です。iOS を更新してから、ホーム画面の OTSUGE を開き直してください。",
      note: "",
    };
  }
  return {
    heading: "通知に非対応",
    description: `このブラウザは通知（Web Push）に対応していません。${SUPPORTED_ENVIRONMENTS}`,
    note: "プライベートブラウズ（シークレットモード）では使えないことがあります。",
  };
}

export function getPushCardView(env: PushEnvironment | null): PushCardView {
  const state = getPushCardState(env);
  if (!env || state === "checking") {
    return { state: "checking", heading: "確認中", description: "この端末の受け取り状態を確認しています。", steps: [], note: "" };
  }
  switch (state) {
    case "needs-install":
      return {
        state,
        heading: "ホーム画面に未追加",
        description:
          "iPhone / iPad では、ホーム画面に追加した OTSUGE から開いたときだけ通知を受け取れます。次の手順で追加してください。",
        steps: [
          "Safari でこのページを開き、共有ボタン（四角から上向きの矢印が出ているアイコン）を押す",
          "メニューから「ホーム画面に追加」を選ぶ",
          "ホーム画面にできた OTSUGE のアイコンから開き、「受け取る」を押す",
        ],
        note: "iOS 16.4 以上が必要です。",
      };
    case "unsupported":
      return { state, steps: [], ...describeUnsupported(env) };
    case "blocked":
      return {
        state,
        heading: "通知ブロック中",
        description:
          "この端末で OTSUGE の通知がブロックされているため、お告げを届けられません。次の手順で許可に変更してください。",
        ...(env.ios
          ? {
              steps: [
                "「設定」アプリを開き、「通知」を選ぶ",
                "一覧から「OTSUGE」を選び、「通知を許可」をオンにする",
                "OTSUGE に戻り、「受け取る」を押す",
              ],
              note: "",
            }
          : {
              steps: [
                "アドレスバーの左にあるアイコン（鍵のマークなど）を押し、サイトの設定を開く",
                "「通知」を「許可」に変更する",
                "このページを再読み込みし、「受け取る」を押す",
              ],
              note: "アドレスバーがない場合は、ブラウザまたは端末の設定にあるサイトごとの通知設定で OTSUGE を許可してください。",
            }),
      };
    case "subscribed":
      return {
        state,
        heading: "受け取り中",
        description: "今日のお告げを待機しています。予定は下の一覧で確認できます。",
        steps: [],
        note: "",
      };
    case "unsubscribed":
      return {
        state,
        heading: "未設定",
        description: "通知を許可すると、今日のどこかでOTSUGEからお告げが届きます。",
        steps: [],
        note: "",
      };
  }
}

export const PERMISSION_DENIED_MESSAGE = "通知がブロックされたため、受け取りを設定できませんでした。";
export const PERMISSION_DISMISSED_MESSAGE =
  "通知の許可が選ばれませんでした。もう一度「受け取る」を押し、表示される確認で「許可」を選んでください。";

/**
 * 許可ダイアログの結果を、購読を続けられない理由の文言にする。許可されたときは null。
 * ブロック（denied）と、選ばずに閉じただけ（default）を区別する。
 */
export function describePermissionRefusal(permission: string): string | null {
  if (permission === "granted") return null;
  return permission === "denied" ? PERMISSION_DENIED_MESSAGE : PERMISSION_DISMISSED_MESSAGE;
}

export const NETWORK_FAILURE_MESSAGE = "通信できませんでした。電波の良い場所でもう一度お試しください。";
export const UNKNOWN_FAILURE_MESSAGE = "うまく処理できませんでした。時間をおいてもう一度お試しください。";

/** ブラウザが投げる購読まわりの例外（DOMException）の name ごとの文言。 */
const DOM_EXCEPTION_MESSAGES: Record<string, string> = {
  // push サービス（FCM / APNs など）に登録できなかった。
  AbortError: "通知サービスに接続できませんでした。通信状況を確認し、時間をおいてもう一度お試しください。",
  NetworkError: "通知サービスに接続できませんでした。通信状況を確認し、時間をおいてもう一度お試しください。",
  NotAllowedError: "通知が許可されていないため、受け取りを設定できませんでした。",
  // Service Worker がまだ有効になっていない、など。
  InvalidStateError: "通知の準備がまだ終わっていません。少し待ってから、もう一度お試しください。",
  NotSupportedError: "このブラウザでは通知の受け取りを設定できませんでした。",
  // サーバーが配っている鍵（VAPID 公開鍵）を使えなかった。
  InvalidAccessError: "通知用の鍵が正しく設定されていません。",
  InvalidCharacterError: "通知用の鍵が正しく設定されていません。",
};

/**
 * 購読・解除の失敗を画面に出す文にする。ブラウザの英語のエラー文はそのまま出さない。
 * アプリ側で投げた Error（api() のサーバー応答など、文言を用意しているもの）は message をそのまま使う。
 */
export function describePushError(error: unknown): string {
  if (!(error instanceof Error)) return UNKNOWN_FAILURE_MESSAGE;
  const known = DOM_EXCEPTION_MESSAGES[error.name];
  if (known) return known;
  // fetch や Service Worker の取得がサーバーに届かなかったとき、ブラウザは TypeError を投げる。
  if (error instanceof TypeError) return NETWORK_FAILURE_MESSAGE;
  const fromBrowser = typeof DOMException !== "undefined" && error instanceof DOMException;
  const fromRuntime = error instanceof RangeError || error instanceof SyntaxError || error instanceof ReferenceError;
  if (fromBrowser || fromRuntime || !error.message) return UNKNOWN_FAILURE_MESSAGE;
  return error.message;
}
