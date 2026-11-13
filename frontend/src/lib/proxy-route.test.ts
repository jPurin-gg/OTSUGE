import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { NextRequest } from "next/server";
import { GET, POST } from "../app/api/[...path]/route";

// 圧縮して返す上流（backend の手前に入った nginx / CDN や、圧縮が有効な backend）の代わり。
// 要求の Accept-Encoding にある符号化から zstd、gzip、無圧縮の順で選ぶ。
const BROWSER_ACCEPT_ENCODING = "gzip, deflate, br, zstd";
const payload = { schedules: Array.from({ length: 200 }, (_, index) => ({ id: index, message: "水を飲め" })) };
const received: IncomingMessage["headers"][] = [];
let upstream: Server;
let backendUrl: string;
const originalBackendUrl = process.env.BACKEND_URL;

function encode(json: string, acceptEncoding: string) {
  if (/\bzstd\b/.test(acceptEncoding)) return { encoding: "zstd", body: zstdCompressSync(json) };
  if (/\bgzip\b/.test(acceptEncoding)) return { encoding: "gzip", body: gzipSync(json) };
  return { encoding: undefined, body: Buffer.from(json) };
}

before(async () => {
  upstream = createServer((request, response) => {
    received.push(request.headers);
    request.resume();
    if (request.url === "/api/admin/login") {
      response.setHeader("set-cookie", ["session=abc; Path=/; HttpOnly", "theme=dark; Path=/"]);
    }
    const json = JSON.stringify(request.url === "/api/admin/login" ? { ok: true } : payload);
    const { encoding, body } = encode(json, String(request.headers["accept-encoding"] ?? ""));
    if (encoding) response.setHeader("content-encoding", encoding);
    response.setHeader("content-type", "application/json");
    response.setHeader("content-length", body.length);
    response.setHeader("cache-control", "no-store");
    response.end(body);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  backendUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  process.env.BACKEND_URL = backendUrl;
});

after(async () => {
  if (originalBackendUrl === undefined) delete process.env.BACKEND_URL;
  else process.env.BACKEND_URL = originalBackendUrl;
  await new Promise((resolve) => upstream.close(resolve));
});

function context(...path: string[]) {
  return { params: Promise.resolve({ path }) };
}

function browserRequest(path: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`http://localhost:3000${path}`, {
    ...init,
    headers: { "accept-encoding": BROWSER_ACCEPT_ENCODING, ...init?.headers },
  });
}

test("the proxy returns a compressed upstream response as a plain body without compression headers", async () => {
  const response = await GET(browserRequest("/api/public/schedules"), context("public", "schedules"));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("transfer-encoding"), null);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), payload);
});

test("the proxy lets fetch choose the encodings instead of forwarding the browser's Accept-Encoding", async () => {
  await fetch(`${backendUrl}/api/public/schedules`);
  const chosenByFetch = received.at(-1)?.["accept-encoding"];

  await GET(browserRequest("/api/public/schedules"), context("public", "schedules"));

  assert.notEqual(chosenByFetch, BROWSER_ACCEPT_ENCODING);
  assert.equal(received.at(-1)?.["accept-encoding"], chosenByFetch);
});

test("the proxy keeps every Set-Cookie of the upstream response", async () => {
  const request = browserRequest("/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "x" }),
  });
  const response = await POST(request, context("admin", "login"));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.deepEqual(response.headers.getSetCookie(), ["session=abc; Path=/; HttpOnly", "theme=dark; Path=/"]);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(received.at(-1)?.["content-type"], "application/json");
  assert.equal(received.at(-1)?.["content-length"], String(JSON.stringify({ password: "x" }).length));
});
