self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open("otsuge-v1").then((cache) => cache.addAll(["/", "/manifest.json"])),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then((response) => response || caches.match("/"))));
});

self.addEventListener("push", (event) => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || "OTSUGE", {
      body: data.body || "通知です。",
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: data.url || "/" },
      tag: data.tag,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(self.clients.openWindow(url));
});

// base64url の公開鍵を subscribe() に渡せるバイト列にする。
function decodeKey(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function sendSubscription(method, body) {
  const response = await fetch("/api/subscriptions", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`購読を更新できませんでした（HTTP ${response.status}）。`);
}

// 更新後の購読を得る。ブラウザが渡してこない場合（購読が失効しただけの場合）は、現在の公開鍵で購読し直す。
async function renewSubscription(event) {
  if (event.newSubscription) return event.newSubscription;
  const existing = await self.registration.pushManager.getSubscription();
  if (existing) return existing;
  const response = await fetch("/api/public/vapid-key");
  const { publicKey } = await response.json();
  if (!publicKey) throw new Error("通知用の鍵を取得できませんでした。");
  return self.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeKey(publicKey),
  });
}

// ブラウザが購読を更新したとき、ページを開いていなくても新しい購読をサーバーに伝える。
// ここで失敗しても、次にページを開いたときに登録し直す（src/lib/push.ts の syncPushSubscription）。
async function handleSubscriptionChange(event) {
  const oldEndpoint = event.oldSubscription?.endpoint;
  const subscription = await renewSubscription(event);
  await sendSubscription("POST", subscription.toJSON());
  // 古い購読は、新しい購読を登録できてから消す。消せなくても、送信時に 404 / 410 が返ればサーバーが消す。
  if (oldEndpoint && oldEndpoint !== subscription.endpoint) {
    await sendSubscription("DELETE", { endpoint: oldEndpoint }).catch(() => {});
  }
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(handleSubscriptionChange(event));
});
