import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { serviceWorkerUrl } from "./sw";

// public/sw.js を、Service Worker のグローバル（self / caches / fetch）を差し替えた環境で実行して検証する。
const SW_SOURCE = readFileSync(path.join(process.cwd(), "public/sw.js"), "utf8");
const ORIGIN = "https://otsuge.test";

// `next build` が出力するトップページの HTML から、アセット参照の形だけを抜き出したもの。
const SHELL_HTML = `<!DOCTYPE html><html lang="ja"><head>
<link rel="stylesheet" href="/_next/static/chunks/0lq9lg7bf_ihd.css" data-precedence="next"/>
<link rel="preload" as="script" fetchPriority="low" href="/_next/static/chunks/turbopack-0ylypyr6t05-0.js"/>
<script src="/_next/static/chunks/14mumt5_n0xhi.js" async=""></script>
<link rel="manifest" href="/manifest.json"/></head>
<body><img srcSet="/_next/image?url=%2Ficon-192.png&amp;w=48&amp;q=75 1x" src="/icon-192.png"/>
<script>self.__next_f.push([1,"3:I[58255,[\\"/_next/static/chunks/14mumt5_n0xhi.js\\",\\"/_next/static/chunks/2n2g8m0wrh53v.js\\"],\\"default\\"]\\n"])</script>
</body></html>`;

const SHELL_ASSETS = [
  "/_next/static/chunks/0lq9lg7bf_ihd.css",
  "/_next/static/chunks/turbopack-0ylypyr6t05-0.js",
  "/_next/static/chunks/14mumt5_n0xhi.js",
  "/_next/static/chunks/2n2g8m0wrh53v.js",
];
const PUBLIC_ASSETS = ["/icon.svg", "/icon-192.png", "/icon-512.png", "/manifest.json"];

type FakeRequest = { url: string; method: string; mode: string };
type Listener = (event: Record<string, unknown>) => void;

class FakeCache {
  readonly entries = new Map<string, Response>();

  async match(request: string | FakeRequest) {
    return this.entries.get(typeof request === "string" ? request : request.url)?.clone();
  }

  async put(request: string | FakeRequest, response: Response) {
    this.entries.set(typeof request === "string" ? request : request.url, response);
  }
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();

  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name)!;
  }

  async keys() {
    return [...this.stores.keys()];
  }

  async delete(name: string) {
    return this.stores.delete(name);
  }

  paths(name: string) {
    return [...(this.stores.get(name)?.entries.keys() ?? [])].map((url) => url.replace(ORIGIN, "")).sort();
  }
}

function html(body: string) {
  return () => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function asset(body: string, type = "application/javascript") {
  return () => new Response(body, { headers: { "Content-Type": type } });
}

function defaultRoutes() {
  const routes = new Map<string, () => Response>();
  routes.set("/", html(SHELL_HTML));
  routes.set("/admin", html("<html>admin</html>"));
  routes.set("/offline.html", html("<html>オフラインです</html>"));
  routes.set("/api/public/schedules", () => Response.json({ schedules: [] }));
  for (const path of [...SHELL_ASSETS, ...PUBLIC_ASSETS]) routes.set(path, asset(`content of ${path}`));
  return routes;
}

/** Service Worker を1つ起動する。caches を渡すと、前のビルドのキャッシュが残った状態を再現できる。 */
function startWorker(options: { buildId?: string; caches?: FakeCacheStorage } = {}) {
  const buildId = options.buildId ?? "build-a";
  const caches = options.caches ?? new FakeCacheStorage();
  const routes = defaultRoutes();
  const network = { online: true, requested: [] as string[] };
  const listeners = new Map<string, Listener>();
  let claimed = false;

  const fetchStub = async (input: string | FakeRequest) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    network.requested.push(url.pathname + url.search);
    if (!network.online) throw new TypeError("Failed to fetch");
    const route = routes.get(url.pathname);
    return route ? route() : new Response("Not Found", { status: 404 });
  };

  const self = {
    location: new URL(buildId ? `${ORIGIN}/sw.js?v=${buildId}` : `${ORIGIN}/sw.js`),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: () => {},
    clients: {
      claim: async () => {
        claimed = true;
      },
    },
  };
  vm.runInNewContext(SW_SOURCE, { self, caches, fetch: fetchStub, URL, Response });

  /** install / activate を発火し、waitUntil に渡された処理が終わるまで待つ。 */
  async function lifecycle(type: "install" | "activate") {
    const pending: Promise<unknown>[] = [];
    listeners.get(type)!({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
  }

  /** fetch イベントを発火する。Service Worker が応答しなかった（ブラウザに任せた）ときは handled が false。 */
  async function request(pathOrUrl: string, init: Partial<FakeRequest> = {}) {
    const pending: Promise<unknown>[] = [];
    let responded: Promise<Response> | undefined;
    listeners.get("fetch")!({
      request: { url: new URL(pathOrUrl, ORIGIN).href, method: "GET", mode: "no-cors", ...init },
      respondWith: (response: Promise<Response>) => {
        responded = Promise.resolve(response);
      },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    if (!responded) return { handled: false as const };
    const response = await responded;
    await Promise.all(pending);
    return { handled: true as const, response, text: await response.clone().text() };
  }

  const navigate = (pathOrUrl: string) => request(pathOrUrl, { mode: "navigate" });

  return {
    caches,
    routes,
    network,
    cacheName: `otsuge-${buildId || "nobuild"}`,
    isClaimed: () => claimed,
    install: () => lifecycle("install"),
    activate: () => lifecycle("activate"),
    request,
    navigate,
  };
}

async function startInstalledWorker(options: { buildId?: string; caches?: FakeCacheStorage } = {}) {
  const worker = startWorker(options);
  await worker.install();
  await worker.activate();
  return worker;
}

test("install precaches the offline page, the top page and every asset the top page refers to", async () => {
  const worker = await startInstalledWorker();
  assert.deepEqual(
    worker.caches.paths(worker.cacheName),
    ["/", "/offline.html", ...SHELL_ASSETS, ...PUBLIC_ASSETS].sort(),
  );
});

test("offline: reloading the top page returns the cached page", async () => {
  const worker = await startInstalledWorker();
  worker.network.online = false;
  const result = await worker.navigate("/");
  assert.equal(result.handled, true);
  assert.equal(result.text, SHELL_HTML);
});

test("offline: the JS and CSS of the top page are served from the cache", async () => {
  const worker = await startInstalledWorker();
  worker.network.online = false;
  for (const path of SHELL_ASSETS) {
    const result = await worker.request(path);
    assert.equal(result.handled, true);
    assert.equal(result.text, `content of ${path}`);
  }
});

test("offline: /api/ requests are left alone so the page sees the failure, not HTML", async () => {
  const worker = await startInstalledWorker();
  worker.network.online = false;
  assert.equal((await worker.request("/api/public/schedules", { mode: "cors" })).handled, false);
  assert.equal((await worker.request("/api/admin/schedules", { mode: "cors" })).handled, false);
  // /api/ を直接開いた（画面遷移の）場合も代替ページを返さない。
  assert.equal((await worker.navigate("/api/health")).handled, false);
});

test("offline: an uncached JS file fails instead of being replaced with HTML", async () => {
  const worker = await startInstalledWorker();
  worker.network.online = false;
  await assert.rejects(worker.request("/_next/static/chunks/not-cached.js"), TypeError);
});

test("offline: other same-origin requests are not answered by the service worker", async () => {
  const worker = await startInstalledWorker();
  worker.network.online = false;
  assert.equal((await worker.request("/_next/image?url=%2Ficon-192.png&w=48&q=75")).handled, false);
  assert.equal((await worker.request("/?_rsc=abc", { mode: "cors" })).handled, false);
});

test("offline: a page that was never cached falls back to the offline page", async () => {
  const worker = await startInstalledWorker();
  worker.network.online = false;
  const result = await worker.navigate("/admin");
  assert.equal(result.text, "<html>オフラインです</html>");
});

test("a page visited online is cached and returned when offline, ignoring the query string", async () => {
  const worker = await startInstalledWorker();
  assert.equal((await worker.navigate("/admin?from=home")).text, "<html>admin</html>");
  worker.network.online = false;
  assert.equal((await worker.navigate("/admin")).text, "<html>admin</html>");
});

test("online navigation uses the network and refreshes the cached page", async () => {
  const worker = await startInstalledWorker();
  worker.routes.set("/", html("<html>new top page</html>"));
  assert.equal((await worker.navigate("/")).text, "<html>new top page</html>");
  worker.network.online = false;
  assert.equal((await worker.navigate("/")).text, "<html>new top page</html>");
});

test("error pages and non-HTML responses are not cached as pages", async () => {
  const worker = await startInstalledWorker();
  worker.routes.set("/admin", () => new Response("Bad Gateway", { status: 502, headers: { "Content-Type": "text/html" } }));
  assert.equal((await worker.navigate("/admin")).response?.status, 502);
  assert.equal((await worker.navigate("/missing")).response?.status, 404);
  worker.routes.set("/feed", asset("{}", "application/json"));
  await worker.navigate("/feed");
  assert.deepEqual(
    worker.caches.paths(worker.cacheName).filter((path) => ["/admin", "/missing", "/feed"].includes(path)),
    [],
  );
});

test("static assets and icons are cache-first and are cached when first fetched", async () => {
  const worker = await startInstalledWorker();
  worker.routes.set("/_next/static/chunks/admin-page.js", asset("admin v1"));

  assert.equal((await worker.request("/_next/static/chunks/admin-page.js")).text, "admin v1");
  worker.routes.set("/_next/static/chunks/admin-page.js", asset("admin v2"));
  worker.network.requested.length = 0;
  assert.equal((await worker.request("/_next/static/chunks/admin-page.js")).text, "admin v1");
  assert.equal((await worker.request("/icon.svg")).text, "content of /icon.svg");
  assert.deepEqual(worker.network.requested, []);
});

test("a failed asset response is passed through but not cached", async () => {
  const worker = await startInstalledWorker();
  const result = await worker.request("/_next/static/chunks/gone.js");
  assert.equal(result.response?.status, 404);
  assert.equal(worker.caches.paths(worker.cacheName).includes("/_next/static/chunks/gone.js"), false);
});

test("POST and cross-origin requests are not handled", async () => {
  const worker = await startInstalledWorker();
  assert.equal((await worker.request("/", { method: "POST", mode: "navigate" })).handled, false);
  assert.equal((await worker.request("https://cdn.example/_next/static/chunks/x.js")).handled, false);
});

test("the cache name carries the build id, and activate deletes caches of other builds", async () => {
  const caches = new FakeCacheStorage();
  const oldWorker = await startInstalledWorker({ buildId: "build-a", caches });
  await caches.open("otsuge-v1"); // 修正前の sw.js が作ったキャッシュ
  await caches.open("another-app"); // 接頭辞の違うキャッシュには触らない
  assert.equal(oldWorker.cacheName, "otsuge-build-a");

  const newWorker = startWorker({ buildId: "build-b", caches });
  newWorker.routes.set("/", html("<html>build-b</html>"));
  await newWorker.install();
  assert.deepEqual((await caches.keys()).sort(), ["another-app", "otsuge-build-a", "otsuge-build-b", "otsuge-v1"]);

  await newWorker.activate();
  assert.deepEqual((await caches.keys()).sort(), ["another-app", "otsuge-build-b"]);
  assert.equal(newWorker.isClaimed(), true);

  newWorker.network.online = false;
  assert.equal((await newWorker.navigate("/")).text, "<html>build-b</html>");
});

test("install still succeeds when the top page cannot be precached, and no partial page is kept", async () => {
  const worker = startWorker();
  worker.routes.delete("/_next/static/chunks/2n2g8m0wrh53v.js");
  await worker.install();
  await worker.activate();
  assert.deepEqual(worker.caches.paths(worker.cacheName), ["/offline.html"]);

  worker.network.online = false;
  assert.equal((await worker.navigate("/")).text, "<html>オフラインです</html>");
});

test("install fails when the offline page cannot be fetched", async () => {
  const worker = startWorker();
  worker.routes.delete("/offline.html");
  await assert.rejects(worker.install());
});

test("without a build id (dev server) only the offline page is cached", async () => {
  const worker = await startInstalledWorker({ buildId: "" });
  assert.deepEqual(worker.caches.paths(worker.cacheName), ["/offline.html"]);

  await worker.navigate("/");
  assert.equal((await worker.request("/_next/static/chunks/14mumt5_n0xhi.js")).handled, false);
  assert.deepEqual(worker.caches.paths(worker.cacheName), ["/offline.html"]);

  worker.network.online = false;
  assert.equal((await worker.navigate("/")).text, "<html>オフラインです</html>");
  assert.equal((await worker.request("/api/public/schedules", { mode: "cors" })).handled, false);
});

test("serviceWorkerUrl() puts the build id in the query so each build installs a new worker", () => {
  assert.equal(serviceWorkerUrl("mwfe103o"), "/sw.js?v=mwfe103o");
  assert.equal(serviceWorkerUrl("a b"), "/sw.js?v=a%20b");
  assert.equal(serviceWorkerUrl(""), "/sw.js");
});
