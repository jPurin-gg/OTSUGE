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

// 本文が JSON でない Push でも通知を出せるように、読めなかった本文はそのまま通知の本文として扱う。
function readPushData(data) {
  if (!data) return {};
  try {
    const parsed = data.json();
    if (parsed && typeof parsed === "object") return parsed;
    return parsed == null ? {} : { body: String(parsed) };
  } catch {
    try {
      return { body: data.text() };
    } catch {
      return {};
    }
  }
}

self.addEventListener("push", (event) => {
  const data = readPushData(event.data);
  event.waitUntil(
    self.registration.showNotification(data.title || "OTSUGE", {
      body: data.body || "お告げが届きました。",
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: data.url || "/" },
      tag: data.tag,
    }),
  );
});

// 通知をタップしたとき、同じページを開いているウィンドウがあればそれを前面に出す。なければ新しく開く。
async function focusOrOpen(url) {
  const target = new URL(url, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const opened = windows.find((client) => client.url === target);
  if (opened) {
    try {
      return await opened.focus();
    } catch {
      // フォーカスできなかったときは、下で新しく開く。
    }
  }
  return self.clients.openWindow(target);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(focusOrOpen(event.notification.data?.url || "/"));
});
