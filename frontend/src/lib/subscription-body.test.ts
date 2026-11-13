import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SUBSCRIPTION_BODY_BYTES, readProxyBody, SubscriptionBodyError } from "./subscription-body";

function streamRequest(chunks: Uint8Array[], method = "POST", headers?: HeadersInit, onCancel?: () => void) {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
    cancel: onCancel,
  }, { highWaterMark: 0 });
  return new Request("https://otsuge.example/api/subscriptions", {
    method,
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

function isBodyError(status: number) {
  return (error: unknown) => error instanceof SubscriptionBodyError && error.status === status;
}

for (const method of ["POST", "DELETE"]) {
  test(`${method}: declared oversized subscription body is rejected before reading`, async () => {
    const request = streamRequest([new Uint8Array(1)], method, {
      "content-length": String(MAX_SUBSCRIPTION_BODY_BYTES + 1),
    });
    await assert.rejects(readProxyBody(request, "/api/subscriptions"), isBodyError(413));
    assert.equal(request.bodyUsed, false);
  });

  test(`${method}: chunked subscription body is bounded and cancelled`, async () => {
    let cancelled = false;
    const request = streamRequest([
      new Uint8Array(2048),
      new Uint8Array(2049),
      new Uint8Array(2048),
    ], method, undefined, () => { cancelled = true; });
    await assert.rejects(readProxyBody(request, "/api/subscriptions"), isBodyError(413));
    assert.equal(cancelled, true);
    assert.equal(request.body?.locked, false);
  });

  test(`${method}: understated Content-Length cannot bypass the actual byte limit`, async () => {
    const request = streamRequest([new Uint8Array(MAX_SUBSCRIPTION_BODY_BYTES + 1)], method, {
      "content-length": "1",
    });
    await assert.rejects(readProxyBody(request, "/api/subscriptions"), isBodyError(413));
  });
}

test("subscription body at the byte limit is forwarded unchanged", async () => {
  const bytes = new TextEncoder().encode("あ".repeat(1365) + "x");
  assert.equal(bytes.byteLength, MAX_SUBSCRIPTION_BODY_BYTES);
  const request = streamRequest([bytes.slice(0, 100), bytes.slice(100)]);
  assert.deepEqual(new Uint8Array(await readProxyBody(request, "/api/subscriptions")), bytes);
});

test("multi-byte subscription input is measured in bytes", async () => {
  const bytes = new TextEncoder().encode("あ".repeat(1366));
  await assert.rejects(readProxyBody(streamRequest([bytes]), "/api/subscriptions"), isBodyError(413));
});

test("malformed Content-Length is a client error", async () => {
  for (const length of ["invalid", "-1", "1.5", "1e3"]) {
    const request = streamRequest([new Uint8Array(1)], "POST", { "content-length": length });
    await assert.rejects(readProxyBody(request, "/api/subscriptions"), isBodyError(400));
  }
});

test("empty subscription body remains empty for backend validation", async () => {
  const request = new Request("https://otsuge.example/api/subscriptions", { method: "DELETE" });
  assert.equal((await readProxyBody(request, "/api/subscriptions")).byteLength, 0);
});

test("normalized subscription targets cannot bypass the limit via decoded catchall parameters", async () => {
  for (const path of [
    ["subscriptions?ignored"],
    ["subscriptions#ignored"],
    ["other", "..", "subscriptions"],
  ]) {
    const target = new URL(`/api/${path.join("/")}`, "http://backend:3001");
    assert.equal(target.pathname, "/api/subscriptions");
    const request = streamRequest([new Uint8Array(MAX_SUBSCRIPTION_BODY_BYTES + 1)]);
    await assert.rejects(readProxyBody(request, target.pathname), isBodyError(413));
  }
});

test("other API paths and methods retain their existing body behavior", async () => {
  const bytes = new Uint8Array(MAX_SUBSCRIPTION_BODY_BYTES + 1);
  for (const { method, path } of [
    { method: "POST", path: "/api/admin/notifications" },
    { method: "POST", path: "/api/subscriptions/other" },
    { method: "PUT", path: "/api/subscriptions" },
  ]) {
    const request = streamRequest([bytes], method);
    assert.deepEqual(new Uint8Array(await readProxyBody(request, path)), bytes);
  }
});
