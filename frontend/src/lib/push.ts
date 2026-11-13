import { api } from "./api";

/** Service Worker が有効になるのを待つ上限。インストールに失敗すると `ready` は解決しないので、待ち続けない。 */
export const SERVICE_WORKER_READY_TIMEOUT_MS = 30_000;

export const SERVICE_WORKER_NOT_READY_MESSAGE = "通知の準備が終わりませんでした。通信状態を確認して、もう一度お試しください。";

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

/** Service Worker が有効になるまで待つ。有効になる前に subscribe() を呼ぶと失敗する。 */
async function waitForServiceWorker() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(SERVICE_WORKER_NOT_READY_MESSAGE)), SERVICE_WORKER_READY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function subscribePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("このブラウザでは通知を使えません。");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("通知が許可されませんでした。");

  await navigator.serviceWorker.register("/sw.js");
  const registration = await waitForServiceWorker();
  const { publicKey } = await api<{ publicKey: string }>("/api/public/vapid-key");
  if (!publicKey) throw new Error("通知用の鍵がまだ設定されていません。");

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  await api("/api/subscriptions", {
    method: "POST",
    body: JSON.stringify(subscription.toJSON()),
  });
  return subscription;
}

export async function unsubscribePush() {
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return false;
  await api("/api/subscriptions", {
    method: "DELETE",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
  return true;
}

export async function getSubscriptionStatus() {
  const registration = await navigator.serviceWorker.getRegistration();
  return Boolean(await registration?.pushManager.getSubscription());
}
