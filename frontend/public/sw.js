// OTSUGE の Service Worker。役割は Web Push の受信と、オフライン時の最低限表示の2つ。
//
// オフライン時に代替の HTML を返すのは画面遷移（navigate）だけにする。
// /api/ やその他の要求には手を出さず、失敗は失敗としてページに返す。
// （API や JS の要求に HTML を返すと、ページが成功と誤認して壊れる。）

// ビルド識別子。ページが `/sw.js?v=<識別子>` で登録する（src/lib/sw.ts）。
// 識別子がないとき（開発サーバー）は、古くなったことを判定できないので JS・CSS・ページをキャッシュしない。
const BUILD_ID = new URL(self.location.href).searchParams.get("v") || "";
const CACHE_PREFIX = "otsuge-";
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID || "nobuild"}`;

const OFFLINE_URL = "/offline.html";
const SHELL_URL = "/";
const PUBLIC_ASSETS = ["/icon.svg", "/icon-192.png", "/icon-512.png", "/manifest.json"];
const MATCH_OPTIONS = { ignoreVary: true };

function absolute(path) {
  return new URL(path, self.location.origin).href;
}

async function fetchOk(path, init) {
  const response = await fetch(absolute(path), init);
  if (!response.ok) throw new Error(`${path} を取得できませんでした（HTTP ${response.status}）。`);
  return response;
}

// ページの HTML が参照している /_next/static/ のファイルを取り出す。
function findStaticAssets(html) {
  const found = html.match(/\/_next\/static\/[^"'\\\s<>?#&]+\.[a-z0-9]+/g) || [];
  return [...new Set(found)];
}

// トップページと、その表示に必要な JS・CSS・アイコンをまとめて入れる。
// 初回表示の時点ではまだこの Service Worker が要求を仲介していないので、実行時キャッシュだけでは揃わない。
// ページは最後に入れる。JS・CSS が欠けた状態のページをオフラインで返さないため。
async function precacheShell(cache) {
  const shell = await fetchOk(SHELL_URL, { cache: "reload" });
  const html = await shell.clone().text();
  const assets = [...new Set([...PUBLIC_ASSETS, ...findStaticAssets(html)])];
  const responses = await Promise.all(assets.map((path) => fetchOk(path)));
  await Promise.all(assets.map((path, index) => cache.put(absolute(path), responses[index])));
  await cache.put(absolute(SHELL_URL), shell);
}

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  // オフライン用ページだけは必須。取得できなければインストールを失敗させ、次回の登録でやり直す。
  await cache.put(absolute(OFFLINE_URL), await fetchOk(OFFLINE_URL, { cache: "reload" }));
  if (!BUILD_ID) return;
  // こちらは失敗してもインストールは続ける（通知の受信を止めないため）。足りない分は実行時キャッシュで埋まる。
  await precacheShell(cache).catch(() => {});
}

async function deleteOldCaches() {
  const names = await caches.keys();
  await Promise.all(
    names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)),
  );
}

function isStaticAsset(url) {
  return url.pathname.startsWith("/_next/static/") || PUBLIC_ASSETS.includes(url.pathname);
}

// ページはクエリを除いた URL で保存する（`/?utm=...` のような違いでキャッシュを増やさない）。
function pageKey(requestUrl) {
  const url = new URL(requestUrl);
  return url.origin + url.pathname;
}

function isCacheablePage(response) {
  return response.ok && !response.redirected && (response.headers.get("content-type") || "").includes("text/html");
}

// 画面遷移: ネットワーク優先。通信できないときだけ、同じページのキャッシュ → オフライン用ページの順で返す。
async function handleNavigation(event) {
  const key = pageKey(event.request.url);
  try {
    const response = await fetch(event.request);
    if (BUILD_ID && isCacheablePage(response)) {
      const copy = response.clone();
      event.waitUntil(
        caches
          .open(CACHE_NAME)
          .then((cache) => cache.put(key, copy))
          .catch(() => {}),
      );
    }
    return response;
  } catch (error) {
    const cache = await caches.open(CACHE_NAME);
    const cached =
      (BUILD_ID && (await cache.match(key, MATCH_OPTIONS))) || (await cache.match(absolute(OFFLINE_URL), MATCH_OPTIONS));
    if (cached) return cached;
    throw error;
  }
}

// /_next/static/ とアイコン: キャッシュ優先。なければ取得し、取得できたものを保存する。
// 取得に失敗したときは失敗のまま返す（HTML で代替しない）。
async function handleStaticAsset(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(event.request, MATCH_OPTIONS);
  if (cached) return cached;
  const response = await fetch(event.request);
  if (response.ok) {
    const copy = response.clone();
    event.waitUntil(cache.put(event.request, copy).catch(() => {}));
  }
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(deleteOldCaches().then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(event));
  } else if (BUILD_ID && isStaticAsset(url)) {
    event.respondWith(handleStaticAsset(event));
  }
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
