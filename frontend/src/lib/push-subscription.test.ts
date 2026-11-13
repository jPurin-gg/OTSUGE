import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import * as push from "./push";

// push.ts はブラウザのグローバル（navigator / window / Notification / fetch）を使う。
// 購読を持つブラウザと、購読を保存するサーバーを差し替えて、両者のずれが直ることを検証する。

const KEY_A = "AQIDBAUGBwg"; // base64url。バイト列は 1..8
const KEY_B = "CQoLDA0ODxA"; // バイト列は 9..16

const GLOBALS = ["navigator", "window", "Notification", "fetch"] as const;
const originals = GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

function decode(key: string) {
  return Uint8Array.from(Buffer.from(key, "base64url"));
}

type FakeSubscription = {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: () => Promise<boolean>;
};

type Setup = {
  /** サーバーが配っている公開鍵。 */
  serverKey?: string;
  /** ブラウザに既にある購読を作った鍵。null は、購読はあるが鍵を読み取れないブラウザ。 */
  subscribedWith?: string | null;
  /** サーバーにその購読が登録されているか。 */
  registered?: boolean;
  /** register() の時点で Service Worker がまだ有効になっていない。 */
  workerActive?: boolean;
  /** Service Worker が有効にならない（インストールの失敗）。 */
  workerNeverReady?: boolean;
  /** subscribe() を失敗させる。 */
  subscribeFails?: boolean;
  /** POST /api/subscriptions の応答ステータス。 */
  postStatus?: number;
};

function install(setup: Setup = {}) {
  const server = {
    key: setup.serverKey ?? KEY_A,
    endpoints: new Set<string>(),
    requests: [] as string[],
  };
  const browser = { subscription: null as FakeSubscription | null, created: 0, active: setup.workerActive ?? true };

  function createSubscription(key: Uint8Array | null): FakeSubscription {
    browser.created += 1;
    const endpoint = `https://push.example/send/${browser.created}`;
    const subscription: FakeSubscription = {
      endpoint,
      options: { applicationServerKey: key ? (key.buffer.slice(0) as ArrayBuffer) : null },
      toJSON: () => ({ endpoint, keys: { p256dh: "p256dh", auth: "auth" } }),
      unsubscribe: async () => {
        if (browser.subscription === subscription) browser.subscription = null;
        return true;
      },
    };
    return subscription;
  }

  if (setup.subscribedWith !== undefined) {
    browser.subscription = createSubscription(setup.subscribedWith === null ? null : decode(setup.subscribedWith));
    if (setup.registered ?? true) server.endpoints.add(browser.subscription.endpoint);
  }

  const registration = {
    pushManager: {
      getSubscription: async () => browser.subscription,
      subscribe: async (options: { applicationServerKey: Uint8Array }) => {
        if (!browser.active) throw new Error("Subscription failed - no active Service Worker");
        if (setup.subscribeFails) throw new Error("Registration failed - push service error");
        const current = browser.subscription;
        if (current) {
          const currentKey = new Uint8Array(current.options.applicationServerKey ?? new ArrayBuffer(0));
          const sameKey = Buffer.from(currentKey).equals(Buffer.from(options.applicationServerKey));
          if (!sameKey) throw new Error("A subscription with a different applicationServerKey already exists");
          return current;
        }
        browser.subscription = createSubscription(options.applicationServerKey);
        return browser.subscription;
      },
    },
  };

  const define = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const Notification = { permission: "granted", requestPermission: async () => "granted" };
  define("navigator", {
    serviceWorker: {
      register: async () => registration,
      getRegistration: async () => registration,
      // 有効になるのは register() より後。それまで subscribe() は失敗する。
      get ready() {
        if (setup.workerNeverReady) return new Promise(() => {});
        return new Promise((resolve) => setImmediate(resolve)).then(() => {
          browser.active = true;
          return registration;
        });
      },
    },
  });
  define("window", { PushManager: class {}, Notification, atob });
  define("Notification", Notification);
  define("fetch", async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const path = new URL(input, "https://otsuge.test").pathname;
    server.requests.push(`${method} ${path}`);
    if (path === "/api/public/vapid-key") return Response.json({ publicKey: server.key });
    if (path === "/api/subscriptions" && method === "POST") {
      if (setup.postStatus) return Response.json({ error: "登録に失敗しました。" }, { status: setup.postStatus });
      server.endpoints.add(JSON.parse(String(init.body)).endpoint);
      return Response.json({ ok: true });
    }
    if (path === "/api/subscriptions" && method === "DELETE") {
      server.endpoints.delete(JSON.parse(String(init.body)).endpoint);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  });

  return { server, browser };
}

function silenceConsoleError(t: { mock: { method: (object: object, name: "error", implementation: () => void) => unknown } }) {
  t.mock.method(console, "error", () => {});
}

test("subscribePush() waits for the service worker to become active before subscribing", async () => {
  const { server, browser } = install({ workerActive: false });
  const subscription = await push.subscribePush();
  assert.equal(subscription.endpoint, "https://push.example/send/1");
  assert.equal(browser.created, 1);
  assert.deepEqual([...server.endpoints], ["https://push.example/send/1"]);
});

test("subscribePush() gives up with a message when the service worker never becomes active", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { browser } = install({ workerActive: false, workerNeverReady: true });
  const result = assert.rejects(push.subscribePush(), { message: push.SERVICE_WORKER_NOT_READY_MESSAGE });
  // requestPermission() と register() が終わり、待ち始めるまで進める。
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(push.SERVICE_WORKER_READY_TIMEOUT_MS);
  await result;
  assert.equal(browser.created, 0);
});

test("subscribePush() replaces a subscription that was made with another key", async () => {
  const { server, browser } = install({ serverKey: KEY_B, subscribedWith: KEY_A });
  const subscription = await push.subscribePush();
  assert.equal(subscription.endpoint, "https://push.example/send/2");
  assert.deepEqual(new Uint8Array(browser.subscription!.options.applicationServerKey!), decode(KEY_B));
  assert.deepEqual([...server.endpoints], ["https://push.example/send/2"]);
});

test("sync: a subscription the server has lost is registered again", async () => {
  const { server, browser } = install({ subscribedWith: KEY_A, registered: false });
  assert.deepEqual(await push.syncPushSubscription(), { subscribed: true, notice: "" });
  assert.deepEqual([...server.endpoints], ["https://push.example/send/1"]);
  // 鍵が同じなら購読は作り直さない。
  assert.equal(browser.created, 1);
});

test("sync: sending a subscription the server already has changes nothing", async () => {
  const { server, browser } = install({ subscribedWith: KEY_A });
  assert.deepEqual(await push.syncPushSubscription(), { subscribed: true, notice: "" });
  assert.deepEqual([...server.endpoints], ["https://push.example/send/1"]);
  assert.equal(browser.created, 1);
  assert.deepEqual(server.requests, ["GET /api/public/vapid-key", "POST /api/subscriptions"]);
});

test("sync: without a subscription in the browser nothing is sent", async () => {
  const { server } = install();
  assert.deepEqual(await push.syncPushSubscription(), { subscribed: false, notice: "" });
  assert.deepEqual(server.requests, []);
});

test("sync: after the VAPID key changed, the browser subscribes again with the new key", async () => {
  const { server, browser } = install({ serverKey: KEY_B, subscribedWith: KEY_A });
  assert.deepEqual(await push.syncPushSubscription(), { subscribed: true, notice: "" });
  assert.equal(browser.subscription!.endpoint, "https://push.example/send/2");
  assert.deepEqual(new Uint8Array(browser.subscription!.options.applicationServerKey!), decode(KEY_B));
  // 新しい購読だけが登録され、古い購読はサーバーから消える。
  assert.deepEqual([...server.endpoints], ["https://push.example/send/2"]);
});

test("sync: a subscription whose key cannot be read is kept and sent as is", async () => {
  const { server, browser } = install({ serverKey: KEY_B, subscribedWith: null, registered: false });
  assert.deepEqual(await push.syncPushSubscription(), { subscribed: true, notice: "" });
  assert.equal(browser.created, 1);
  assert.deepEqual([...server.endpoints], ["https://push.example/send/1"]);
});

test("sync: when the server cannot be reached, the card stays subscribed and a notice is returned", async (t) => {
  silenceConsoleError(t);
  const { server } = install({ subscribedWith: KEY_A, registered: false, postStatus: 500 });
  assert.deepEqual(await push.syncPushSubscription(), { subscribed: true, notice: push.SYNC_FAILED_MESSAGE });
  assert.deepEqual([...server.endpoints], []);
});

test("sync: when subscribing again fails, the card goes back to unsubscribed and asks to subscribe", async (t) => {
  silenceConsoleError(t);
  const { server, browser } = install({ serverKey: KEY_B, subscribedWith: KEY_A, subscribeFails: true });
  assert.deepEqual(await push.syncPushSubscription(), { subscribed: false, notice: push.RESUBSCRIBE_NEEDED_MESSAGE });
  assert.equal(browser.subscription, null);
  // ブラウザから消えた購読は、サーバーにも残さない。
  assert.deepEqual([...server.endpoints], []);
});

test("sync: a browser without Service Worker is read as unsubscribed instead of throwing", async () => {
  install();
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
  assert.deepEqual(await push.syncPushSubscription(), { subscribed: false, notice: "" });
});
