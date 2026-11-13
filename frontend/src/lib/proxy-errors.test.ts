import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET, POST, PUT, PATCH, DELETE, OPTIONS } from "../app/api/[...path]/route";
import { api } from "./api";

function context(...path: string[]) {
  return { params: Promise.resolve({ path }) };
}

test("all proxy methods refuse internal API paths before reading the body or fetching", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  for (const [method, handler] of [["GET", GET], ["HEAD", GET], ["POST", POST], ["PUT", PUT], ["PATCH", PATCH], ["DELETE", DELETE], ["OPTIONS", OPTIONS]] as const) {
    for (const path of [["internal"], ["internal", "dispatch"], ["internal", "generate"], ["public", "..", "internal", "dispatch"], ["%69nternal", "dispatch"], ["public%2f..%2finternal", "dispatch"], ["public\\..\\internal", "dispatch"], ["", "internal", "dispatch"]]) {
      const request = new NextRequest("http://localhost:3000/api/internal/dispatch", {
        method,
        body: method === "GET" || method === "HEAD" ? undefined : "{}",
      });
      const read = t.mock.method(request, "arrayBuffer", async () => { throw new Error("must not read"); });
      const response = await handler(request, context(...path));
      assert.equal(response.status, 403, path.join("/"));
      assert.deepEqual(await response.json(), { error: "アクセスが拒否されました。" });
      assert.equal(read.mock.callCount(), 0);
    }
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("upstream 5xx bodies and status text are replaced, with a server log reference", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const upstreamId = "0d5925a1-3624-4abe-af46-85e4dd4e1672";
  for (const status of [500, 502, 503]) {
    const upstream = new Response("SELECT secret: INTERNAL_TEST_VALUE at /private/db.ts:42", {
      status,
      statusText: "INTERNAL_TEST_VALUE",
      headers: { "x-request-id": upstreamId, "x-debug-secret": "INTERNAL_TEST_VALUE", "content-length": "999" },
    });
    t.mock.method(globalThis, "fetch", async () => upstream);
    const response = await GET(new NextRequest("http://localhost:3000/api/public/schedules"), context("public", "schedules"));
    assert.equal(response.status, status);
    assert.equal(response.statusText.includes("INTERNAL_TEST_VALUE"), false);
    assert.equal(response.headers.get("x-debug-secret"), null);
    assert.equal(response.headers.get("x-request-id"), upstreamId);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: `サーバーエラーが発生しました。（参照ID: ${upstreamId}）`, requestId: upstreamId });
    assert.deepEqual(log.mock.calls.at(-1)?.arguments, ["API proxy failed", {
      requestId: upstreamId, error: { status, body: "SELECT secret: INTERNAL_TEST_VALUE at /private/db.ts:42" },
    }]);
  }
});

test("connection failures return a generic 502 and the UI receives its reference", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const error = new Error("connect INTERNAL_TEST_VALUE http://private-backend:3001 at /private/proxy.ts:42");
  t.mock.method(globalThis, "fetch", async () => { throw error; });
  const response = await GET(new NextRequest("http://localhost:3000/api/health"), context("health"));
  const body = await response.clone().json();
  assert.equal(response.status, 502);
  assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(body, { error: `サーバーエラーが発生しました。（参照ID: ${body.requestId}）`, requestId: body.requestId });
  assert.equal(response.headers.get("x-request-id"), body.requestId);
  assert.deepEqual(log.mock.calls.at(-1)?.arguments, ["API proxy failed", { requestId: body.requestId, error }]);
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(api("/api/health"), { message: body.error });
});

test("invalid upstream references are replaced with a generated safe ID", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => new Response("INTERNAL_TEST_VALUE", { status: 500, headers: { "x-request-id": "INTERNAL_TEST_VALUE" } }));
  const response = await GET(new NextRequest("http://localhost:3000/api/health"), context("health"));
  const body = await response.json();
  assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(body).includes("INTERNAL_TEST_VALUE"), false);
});

test("body read failures are logged and return a generic 502", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const error = new Error("INTERNAL_TEST_VALUE at /private/body-reader.ts:12");
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
  const request = new NextRequest("http://localhost:3000/api/subscriptions", { method: "POST", body: "{}" });
  t.mock.method(request, "arrayBuffer", async () => { throw error; });
  const response = await POST(request, context("subscriptions"));
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.deepEqual(body, { error: `サーバーエラーが発生しました。（参照ID: ${body.requestId}）`, requestId: body.requestId });
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(log.mock.calls.at(-1)?.arguments, ["API proxy failed", { requestId: body.requestId, error }]);
});

test("4xx responses retain the existing error, details, and headers", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  for (const status of [400, 401, 403, 413, 429]) {
    const body = { error: "入力内容が不正です。", details: [{ path: ["message"], message: "必須項目です。" }] };
    const upstream = Response.json(body, { status, headers: { "retry-after": "2" } });
    t.mock.method(globalThis, "fetch", async () => upstream);
    const response = await POST(new NextRequest("http://localhost:3000/api/subscriptions", { method: "POST", body: "{}" }), context("subscriptions"));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), body);
    assert.equal(response.headers.get("retry-after"), "2");
  }
  assert.equal(log.mock.callCount(), 0);
});

test("successful login proxying keeps request data and Set-Cookie headers", async (t) => {
  const upstream = Response.json({ ok: true });
  upstream.headers.append("set-cookie", "session=test; HttpOnly; Path=/");
  upstream.headers.append("set-cookie", "theme=dark; Path=/");
  const fetchMock = t.mock.method(globalThis, "fetch", async () => upstream);
  const request = new NextRequest("http://localhost:3000/api/admin/login?mode=test", { method: "POST", headers: { cookie: "session=test", "content-type": "application/json" }, body: '{"password":"test"}' });
  const response = await POST(request, context("admin", "login"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(response.headers.getSetCookie(), upstream.headers.getSetCookie());
  const [target, options] = fetchMock.mock.calls[0].arguments as unknown as [URL, RequestInit];
  assert.equal(target.pathname, "/api/admin/login");
  assert.equal(target.search, "?mode=test");
  assert.equal(options.method, "POST");
  assert.equal(new Headers(options.headers).get("cookie"), "session=test");
  assert.equal(Buffer.from(options.body as ArrayBuffer).toString(), '{"password":"test"}');
});
