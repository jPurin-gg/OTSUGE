import { useSyncExternalStore } from "react";

/**
 * fetch 自体が失敗した（サーバーに届かなかった）エラーかどうか。
 * fetch は通信できないとき TypeError を投げる。status が 0 のエラーも同じ意味として扱う。
 */
export function isNetworkFailure(error: unknown) {
  if (error instanceof TypeError) return true;
  return error instanceof Error && (error as { status?: unknown }).status === 0;
}

// navigator.onLine は「回線につながっているか」しか見ない。電波が悪くて届かないときも true のままなので、
// 実際の通信結果（reportConnectivity）も合わせてオフラインかどうかを決める。
let unreachable = false;
const listeners = new Set<() => void>();

function setUnreachable(value: boolean) {
  if (unreachable === value) return;
  unreachable = value;
  listeners.forEach((listener) => listener());
}

/** サーバーとの通信結果を伝える。届いたら true、届かなかったら false。 */
export function reportConnectivity(reachable: boolean) {
  setUnreachable(!reachable);
}

export function isOffline() {
  return unreachable || (typeof navigator !== "undefined" && navigator.onLine === false);
}

function subscribe(listener: () => void) {
  // 回線が戻ったら「届かなかった」という記録は捨てる。次の通信結果で決め直す。
  const onOnline = () => {
    unreachable = false;
    listener();
  };
  listeners.add(listener);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", listener);
  };
}

/** オフラインかどうか。サーバー側の描画と最初の描画では false。 */
export function useOffline() {
  return useSyncExternalStore(subscribe, isOffline, () => false);
}
