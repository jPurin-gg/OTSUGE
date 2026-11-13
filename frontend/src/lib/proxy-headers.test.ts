import assert from "node:assert/strict";
import test from "node:test";
import { toProxyResponseHeaders, toUpstreamRequestHeaders } from "./proxy-headers";

test("toUpstreamRequestHeaders() drops the headers fetch has to set by itself", () => {
  const headers = toUpstreamRequestHeaders(
    new Headers({
      Host: "localhost:3000",
      "Content-Length": "18",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Content-Type": "application/json",
    }),
  );

  assert.deepEqual([...headers.keys()], ["content-type"]);
});

test("toUpstreamRequestHeaders() keeps the headers the backend reads", () => {
  const headers = toUpstreamRequestHeaders(
    new Headers({
      cookie: "session=abc",
      authorization: "Bearer token",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0",
      "x-forwarded-for": "203.0.113.7",
    }),
  );

  assert.equal(headers.get("cookie"), "session=abc");
  assert.equal(headers.get("authorization"), "Bearer token");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("user-agent"), "Mozilla/5.0");
  assert.equal(headers.get("x-forwarded-for"), "203.0.113.7");
});

test("toProxyResponseHeaders() drops the headers that no longer match the decoded body", () => {
  const headers = toProxyResponseHeaders(
    new Headers({
      "Content-Encoding": "gzip",
      "Content-Length": "1727",
      "Transfer-Encoding": "chunked",
      "Content-Type": "application/json",
    }),
  );

  assert.deepEqual([...headers.keys()], ["content-type"]);
});

test("toProxyResponseHeaders() keeps everything else, including every Set-Cookie", () => {
  const upstream = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
    location: "/admin",
    vary: "Accept-Encoding",
  });
  upstream.append("set-cookie", "session=abc; Path=/; HttpOnly");
  upstream.append("set-cookie", "theme=dark; Path=/");

  const headers = toProxyResponseHeaders(upstream);

  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(headers.get("location"), "/admin");
  assert.equal(headers.get("vary"), "Accept-Encoding");
  assert.deepEqual(headers.getSetCookie(), ["session=abc; Path=/; HttpOnly", "theme=dark; Path=/"]);
});

test("toProxyResponseHeaders() leaves the upstream headers untouched", () => {
  // fetch() の応答ヘッダは変更できない（delete すると TypeError）ので、写しを作って返す。
  const upstream = Response.redirect("http://localhost:3000/admin").headers;
  assert.throws(() => upstream.delete("location"), TypeError);

  const headers = toProxyResponseHeaders(upstream);
  headers.set("x-extra", "1");

  assert.equal(headers.get("location"), "http://localhost:3000/admin");
  assert.equal(upstream.get("x-extra"), null);
});
