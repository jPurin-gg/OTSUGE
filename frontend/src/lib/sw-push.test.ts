import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

// public/sw.js を、Service Worker のグローバル（self / fetch）を差し替えた環境で実行し、
// pushsubscriptionchange で新しい購読がサーバーに伝わることを検証する。
const SW_SOURCE = readFileSync(path.join(process.cwd(), "public/sw.js"), "utf8");
const ORIGIN = "https://otsuge.test";
const PUBLIC_KEY = "AQIDBAUGBwg"; // base64url。バイト列は 1..8

type Listener = (event: Record<string, unknown>) => void;
type FakeSubscription = { endpoint: string; toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } } };

function subscription(endpoint: string): FakeSubscription {
  return { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: "p256dh", auth: "auth" } }) };
}

type Setup = {
  /** サーバーに登録済みの endpoint。 */
  registered?: string[];
  /** ブラウザが保持している購読（getSubscription() の結果）。 */
  current?: FakeSubscription | null;
  /** subscribe() を失敗させる（通知の許可が取り消された場合など）。 */
  subscribeFails?: boolean;
  postStatus?: number;
  deleteStatus?: number;
};

function startWorker(setup: Setup = {}) {
  const server = { endpoints: new Set(setup.registered ?? []), requests: [] as string[] };
  const subscribed: { userVisibleOnly: boolean; key: number[] }[] = [];
  const listeners = new Map<string, Listener>();

  const fetchStub = async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const pathname = new URL(input, ORIGIN).pathname;
    server.requests.push(`${method} ${pathname}`);
    if (pathname === "/api/public/vapid-key") return Response.json({ publicKey: PUBLIC_KEY });
    if (pathname === "/api/subscriptions" && method === "POST") {
      if (setup.postStatus) return Response.json({ error: "failed" }, { status: setup.postStatus });
      assert.equal(new Headers(init.headers).get("content-type"), "application/json");
      const body = JSON.parse(String(init.body));
      assert.deepEqual(Object.keys(body.keys).sort(), ["auth", "p256dh"]);
      server.endpoints.add(body.endpoint);
      return Response.json({ ok: true });
    }
    if (pathname === "/api/subscriptions" && method === "DELETE") {
      if (setup.deleteStatus) return Response.json({ error: "failed" }, { status: setup.deleteStatus });
      server.endpoints.delete(JSON.parse(String(init.body)).endpoint);
      return Response.json({ ok: true });
    }
    return new Response("Not Found", { status: 404 });
  };

  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: () => {},
    clients: { claim: async () => {} },
    registration: {
      pushManager: {
        getSubscription: async () => setup.current ?? null,
        subscribe: async (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
          if (setup.subscribeFails) throw new Error("Registration failed - permission denied");
          subscribed.push({ userVisibleOnly: options.userVisibleOnly, key: [...options.applicationServerKey] });
          return subscription(`https://push.example/send/resubscribed-${subscribed.length}`);
        },
      },
    },
  };
  vm.runInNewContext(SW_SOURCE, { self, caches: {}, fetch: fetchStub, atob, URL, Response });

  /** pushsubscriptionchange を発火し、waitUntil に渡された処理が終わるまで待つ。 */
  async function change(event: { oldSubscription?: FakeSubscription | null; newSubscription?: FakeSubscription | null }) {
    const listener = listeners.get("pushsubscriptionchange");
    assert.ok(listener, "sw.js は pushsubscriptionchange を処理する");
    const pending: Promise<unknown>[] = [];
    listener({ ...event, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    assert.equal(pending.length, 1, "処理が終わるまで Service Worker を止めさせない（waitUntil）");
    await Promise.all(pending);
  }

  return { server, subscribed, change };
}

const OLD = "https://push.example/send/old";
const NEW = "https://push.example/send/new";

test("pushsubscriptionchange: the new subscription replaces the old one on the server", async () => {
  const worker = startWorker({ registered: [OLD] });
  await worker.change({ oldSubscription: subscription(OLD), newSubscription: subscription(NEW) });
  assert.deepEqual([...worker.server.endpoints], [NEW]);
  assert.deepEqual(worker.subscribed, []);
});

test("pushsubscriptionchange: without a new subscription, the worker subscribes again with the current key", async () => {
  const worker = startWorker({ registered: [OLD] });
  await worker.change({ oldSubscription: subscription(OLD), newSubscription: null });
  assert.deepEqual(worker.subscribed, [{ userVisibleOnly: true, key: [1, 2, 3, 4, 5, 6, 7, 8] }]);
  assert.deepEqual([...worker.server.endpoints], ["https://push.example/send/resubscribed-1"]);
});

test("pushsubscriptionchange: a subscription the browser already holds is sent without subscribing again", async () => {
  const worker = startWorker({ registered: [OLD], current: subscription(NEW) });
  await worker.change({});
  assert.deepEqual(worker.subscribed, []);
  // 古い購読が分からないときは何も消さない。
  assert.deepEqual([...worker.server.endpoints].sort(), [NEW, OLD].sort());
  assert.deepEqual(worker.server.requests, ["POST /api/subscriptions"]);
});

test("pushsubscriptionchange: the old subscription is kept when the new one could not be registered", async () => {
  const worker = startWorker({ registered: [OLD], postStatus: 500 });
  await assert.rejects(worker.change({ oldSubscription: subscription(OLD), newSubscription: subscription(NEW) }));
  assert.deepEqual([...worker.server.endpoints], [OLD]);
  assert.deepEqual(worker.server.requests, ["POST /api/subscriptions"]);
});

test("pushsubscriptionchange: when subscribing again fails, nothing is sent", async () => {
  const worker = startWorker({ registered: [OLD], subscribeFails: true });
  await assert.rejects(worker.change({ oldSubscription: subscription(OLD), newSubscription: null }));
  assert.deepEqual([...worker.server.endpoints], [OLD]);
  assert.deepEqual(worker.server.requests, ["GET /api/public/vapid-key"]);
});

test("pushsubscriptionchange: failing to delete the old subscription does not fail the update", async () => {
  const worker = startWorker({ registered: [OLD], deleteStatus: 500 });
  await worker.change({ oldSubscription: subscription(OLD), newSubscription: subscription(NEW) });
  assert.deepEqual([...worker.server.endpoints].sort(), [NEW, OLD].sort());
});

test("pushsubscriptionchange: the same endpoint is sent again and not deleted", async () => {
  const worker = startWorker({ registered: [OLD] });
  await worker.change({ oldSubscription: subscription(OLD), newSubscription: subscription(OLD) });
  assert.deepEqual([...worker.server.endpoints], [OLD]);
  assert.deepEqual(worker.server.requests, ["POST /api/subscriptions"]);
});
