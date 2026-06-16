import { api } from "./api";

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

export async function subscribePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("このブラウザでは通知を使えません。");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("通知が許可されませんでした。");

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
  const registration = await navigator.serviceWorker.getRegistration();
  return Boolean(await registration?.pushManager.getSubscription());
}
