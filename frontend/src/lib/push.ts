import { api } from "./api";

/** Service Worker が有効になるのを待つ上限。インストールに失敗すると `ready` は解決しないので、待ち続けない。 */
export const SERVICE_WORKER_READY_TIMEOUT_MS = 30_000;

export const SERVICE_WORKER_NOT_READY_MESSAGE = "通知の準備が終わりませんでした。通信状態を確認して、もう一度お試しください。";
export const SYNC_FAILED_MESSAGE =
  "通知の登録をサーバーに確認できませんでした。通知が届かないときは「更新」を押してください。";
export const RESUBSCRIBE_NEEDED_MESSAGE = "通知の設定が新しくなりました。もう一度「受け取る」を押してください。";

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

async function fetchPublicKey() {
  const { publicKey } = await api<{ publicKey: string }>("/api/public/vapid-key");
  if (!publicKey) throw new Error("通知用の鍵がまだ設定されていません。");
  return urlBase64ToUint8Array(publicKey);
}

/**
 * 購読が別の公開鍵で作られたものか。
 * 鍵を読み取れないブラウザでは「違う」と判定しない（判定できないまま表示のたびに購読を作り直さないため）。
 */
function usesAnotherKey(subscription: PushSubscription, key: Uint8Array) {
  const current = subscription.options?.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length !== key.length || bytes.some((byte, index) => byte !== key[index]);
}

/**
 * 現在の公開鍵での購読を返す。
 * 別の鍵で作られた購読が残っていれば、解除してから作り直す（鍵が違うままでは subscribe() が失敗する）。
 * 作り直したときは、サーバーから消す対象として古い endpoint も返す。
 */
async function subscribeWithKey(registration: ServiceWorkerRegistration, key: Uint8Array<ArrayBuffer>) {
  const existing = await registration.pushManager.getSubscription();
  if (existing && !usesAnotherKey(existing, key)) return { subscription: existing, replacedEndpoint: "" };
  if (existing) await existing.unsubscribe();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  return { subscription, replacedEndpoint: existing && existing.endpoint !== subscription.endpoint ? existing.endpoint : "" };
}

/** 購読をサーバーに登録する。サーバーは endpoint 単位で上書きするので、同じ購読を何度送っても重複しない。 */
async function saveSubscription(subscription: PushSubscription, replacedEndpoint: string) {
  await api("/api/subscriptions", {
    method: "POST",
    body: JSON.stringify(subscription.toJSON()),
  });
  // 作り直す前の購読にはもう届かない。消せなくても、送信時に push サービスが 404 / 410 を返した時点でサーバーが消す。
  if (replacedEndpoint) await deleteSubscription(replacedEndpoint).catch(() => {});
}

async function deleteSubscription(endpoint: string) {
  await api("/api/subscriptions", {
    method: "DELETE",
    body: JSON.stringify({ endpoint }),
  });
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
  const { subscription, replacedEndpoint } = await subscribeWithKey(registration, await fetchPublicKey());
  await saveSubscription(subscription, replacedEndpoint);
  return subscription;
}

export async function unsubscribePush() {
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return false;
  await deleteSubscription(subscription.endpoint);
  await subscription.unsubscribe();
  return true;
}

export async function getSubscriptionStatus() {
  const registration = await navigator.serviceWorker.getRegistration();
  return Boolean(await registration?.pushManager.getSubscription());
}

/** subscribed は同期を終えた時点でブラウザに購読があるか。notice は利用者に見せる案内（なければ空）。 */
export type PushSyncResult = { subscribed: boolean; notice: string };

/**
 * ブラウザの購読をサーバーの登録に揃える。ページの表示時に呼ぶ。
 * - サーバーから購読が消えていても（登録の失敗、404 / 410 での削除、DB の作り直し）、送り直して登録を戻す。
 * - VAPID 鍵が変わっていれば、新しい鍵で購読し直す。
 * 失敗しても例外は投げず、画面に出す案内を返す。
 */
export async function syncPushSubscription(): Promise<PushSyncResult> {
  if (!("serviceWorker" in navigator)) return { subscribed: false, notice: "" };
  const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  const current = await registration?.pushManager.getSubscription().catch(() => null);
  if (!registration || !current) return { subscribed: false, notice: "" };

  try {
    const { subscription, replacedEndpoint } = await subscribeWithKey(registration, await fetchPublicKey());
    await saveSubscription(subscription, replacedEndpoint);
    return { subscribed: true, notice: "" };
  } catch (error) {
    console.error(error);
    const subscribed = Boolean(await registration.pushManager.getSubscription().catch(() => current));
    if (subscribed) return { subscribed, notice: SYNC_FAILED_MESSAGE };
    // 古い購読を解除した後で購読し直せなかった。ブラウザに購読は残っていないので、サーバーの登録も消しておく。
    await deleteSubscription(current.endpoint).catch(() => {});
    return { subscribed, notice: RESUBSCRIBE_NEEDED_MESSAGE };
  }
}
