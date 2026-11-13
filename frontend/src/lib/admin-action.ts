import { describeError, isUnauthorized } from "./api";

export type Notice = { kind: "success" | "error"; text: string };

export const SESSION_EXPIRED_MESSAGE = "ログインの有効期限が切れたか、ログイン状態が無効になりました。もう一度ログインしてください。";

export type ActionHandlers = {
  setBusy: (busy: boolean) => void;
  setNotice: (notice: Notice | null) => void;
  /** 操作中に 401 が返ったときに呼ぶ。ログイン画面に戻す処理を渡す。 */
  onSessionExpired: (reason: string) => void;
};

export type ActionOptions = {
  /** 失敗時の見出し（例: 「お告げの保存」）。 */
  label: string;
  /**
   * 401 をセッション切れとして扱うか。ログイン自体の 401 は「合言葉が違う」なので false にする。
   * 既定は true。
   */
  sessionExpiryOn401?: boolean;
};

/** 操作の結果。文字列なら成功表示、Notice ならそのまま表示、undefined なら表示しない。 */
export type ActionResult = string | Notice | void;

/**
 * 管理画面の操作を包む関数を作る。
 * - 同時に1つしか実行しない（実行中の呼び出しは何もせず false を返す）。React の state 更新を待たずに弾くため、
 *   実行中かどうかはこのクロージャで同期的に持つ。
 * - 実行中は setBusy(true) にしてボタンを無効化させる。
 * - 開始時に前回の表示を消し、成功・失敗を setNotice で表示する。
 * - 401 は onSessionExpired に回す。
 */
export function createActionRunner(handlers: ActionHandlers) {
  let running = false;

  return async function run(options: ActionOptions, action: () => Promise<ActionResult>): Promise<boolean> {
    if (running) return false;
    running = true;
    handlers.setBusy(true);
    handlers.setNotice(null);
    try {
      const result = await action();
      if (typeof result === "string") handlers.setNotice({ kind: "success", text: result });
      else if (result) handlers.setNotice(result);
      return true;
    } catch (error) {
      if ((options.sessionExpiryOn401 ?? true) && isUnauthorized(error)) {
        handlers.onSessionExpired(SESSION_EXPIRED_MESSAGE);
      } else {
        handlers.setNotice({ kind: "error", text: `${options.label}に失敗しました。\n${describeError(error)}` });
      }
      return false;
    } finally {
      running = false;
      handlers.setBusy(false);
    }
  };
}

export type ActionRunner = ReturnType<typeof createActionRunner>;
