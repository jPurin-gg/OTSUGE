import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

type Handler = (event: Record<string, unknown>) => void;
type WindowClient = { url: string; focus: () => Promise<unknown> };

// public/sw.js を偽の Service Worker 環境で読み込み、登録されたイベントハンドラを取り出す。
function loadServiceWorker(windows: WindowClient[] = []) {
  const handlers: Record<string, Handler> = {};
  const shown: { title: string; options: { body: string; data: { url: string }; tag?: string } }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: "https://otsuge.example" },
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    skipWaiting: () => {},
    registration: {
      showNotification: async (title: string, options: (typeof shown)[number]["options"]) => {
        shown.push({ title, options });
      },
    },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
      },
    },
  };
  const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
  vm.runInNewContext(source, { self, URL, caches: {}, fetch: () => {} });

  async function dispatch(type: string, event: Record<string, unknown>) {
    const pending: unknown[] = [];
    handlers[type]({ ...event, waitUntil: (promise: unknown) => pending.push(promise) });
    await Promise.all(pending);
  }
  return { dispatch, shown, opened };
}

function pushData(text: string) {
  return { json: () => JSON.parse(text) as unknown, text: () => text };
}

function clickEvent(url?: string) {
  let closed = false;
  return {
    notification: {
      close: () => {
        closed = true;
      },
      data: url === undefined ? undefined : { url },
    },
    wasClosed: () => closed,
  };
}

test("JSON の Push は、その内容で通知を出す", async () => {
  const sw = loadServiceWorker();
  await sw.dispatch("push", { data: pushData(JSON.stringify({ title: "OTSUGE", body: "水を飲め", url: "/", tag: "otsuge-1" })) });
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, "OTSUGE");
  assert.equal(sw.shown[0].options.body, "水を飲め");
  assert.equal(sw.shown[0].options.tag, "otsuge-1");
});

test("本文が JSON でない Push でも、例外にならず本文をそのまま通知に出す", async () => {
  const sw = loadServiceWorker();
  await sw.dispatch("push", { data: pushData("姿勢を正せ") });
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, "OTSUGE");
  assert.equal(sw.shown[0].options.body, "姿勢を正せ");
  assert.equal(sw.shown[0].options.data.url, "/");
});

test("JSON だがオブジェクトでない本文（数値や null）でも通知を出す", async () => {
  const sw = loadServiceWorker();
  await sw.dispatch("push", { data: pushData("42") });
  await sw.dispatch("push", { data: pushData("null") });
  assert.equal(sw.shown.length, 2);
  assert.equal(sw.shown[0].options.body, "42");
  assert.equal(sw.shown[1].options.body, "お告げが届きました。");
});

test("本文のない Push でも、既定の文言で通知を出す", async () => {
  const sw = loadServiceWorker();
  await sw.dispatch("push", { data: null });
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].options.body, "お告げが届きました。");
});

test("通知をタップしたとき、同じページのウィンドウが開いていればフォーカスし、新しく開かない", async () => {
  let focused = 0;
  const sw = loadServiceWorker([
    { url: "https://otsuge.example/admin", focus: async () => assert.fail("別のページにフォーカスした") },
    {
      url: "https://otsuge.example/",
      focus: async () => {
        focused += 1;
      },
    },
  ]);
  const event = clickEvent("/");
  await sw.dispatch("notificationclick", event);
  assert.equal(event.wasClosed(), true);
  assert.equal(focused, 1);
  assert.deepEqual(sw.opened, []);
});

test("同じページのウィンドウがなければ、新しく開く", async () => {
  const sw = loadServiceWorker([{ url: "https://otsuge.example/admin", focus: async () => assert.fail("フォーカスした") }]);
  await sw.dispatch("notificationclick", clickEvent());
  assert.deepEqual(sw.opened, ["https://otsuge.example/"]);
});

test("フォーカスに失敗したときは、新しく開く", async () => {
  const sw = loadServiceWorker([
    {
      url: "https://otsuge.example/",
      focus: async () => {
        throw new Error("focus failed");
      },
    },
  ]);
  await sw.dispatch("notificationclick", clickEvent("/"));
  assert.deepEqual(sw.opened, ["https://otsuge.example/"]);
});
