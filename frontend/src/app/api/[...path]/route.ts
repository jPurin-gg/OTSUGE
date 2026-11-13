import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

type Context = { params: Promise<{ path: string[] }> };

function proxyError(error: unknown, status = 502, requestId: string = randomUUID()) {
  console.error("API proxy failed", { requestId, error });
  return Response.json(
    { error: `サーバーエラーが発生しました。（参照ID: ${requestId}）`, requestId },
    { status, headers: { "x-request-id": requestId, "cache-control": "no-store" } },
  );
}

async function proxy(request: NextRequest, context: Context) {
  try {
    const { path } = await context.params;
    const target = new URL(`/api/${path.join("/")}`, process.env.BACKEND_URL ?? "http://backend:3001");
    target.search = request.nextUrl.search;

    // URL の正規化・デコードで内部 API になるパスも、中継や本文の読み取りより先に拒否する。
    const pathname = new URL(
      decodeURIComponent(target.pathname).replace(/\\/g, "/").replace(/\/+/g, "/"),
      target.origin,
    ).pathname;
    if (pathname === "/api/internal" || pathname.startsWith("/api/internal/")) {
      return Response.json({ error: "アクセスが拒否されました。" }, { status: 403 });
    }

    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");

    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      redirect: "manual",
    });

    if (response.status >= 500) {
      const upstreamId = response.headers.get("x-request-id") ?? "";
      // backend の参照を維持する。任意のヘッダ値をエラー文言へ混入させない。
      const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(upstreamId) ? upstreamId : randomUUID();
      return proxyError({ status: response.status, body: await response.text() }, response.status, requestId);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    return proxyError(error);
  }
}

export const dynamic = "force-dynamic";
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
