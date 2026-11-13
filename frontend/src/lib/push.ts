import { api } from "./api";
import { describePermissionRefusal, isIos, type PushEnvironment, SUPPORTED_ENVIRONMENTS } from "./push-state";

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

function isPushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** 端末・ブラウザの通知まわりの状態を読む。判定は push-state.ts の getPushCardState で行う。 */
export async function readPushEnvironment(): Promise<PushEnvironment> {
  const supported = isPushSupported();
  return {
    ios: isIos({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0 }),
    // iOS の Safari は display-mode に加えて、独自の navigator.standalone でも知らせる。
    standalone:
      window.matchMedia?.("(display-mode: standalone)").matches === true ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
    secure: window.isSecureContext !== false,
    supported,
    permission: supported ? Notification.permission : "default",
    subscribed: supported ? await getSubscriptionStatus().catch(() => false) : false,
  };
}

export async function subscribePush() {
  if (!isPushSupported()) throw new Error(`このブラウザでは通知を使えません。${SUPPORTED_ENVIRONMENTS}`);

  const refusal = describePermissionRefusal(await Notification.requestPermission());
  if (refusal) throw new Error(refusal);

  const registration = await navigator.serviceWorker.register("/sw.js");
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
  if (!("serviceWorker" in navigator)) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  return Boolean(await registration?.pushManager.getSubscription());
}
