import { NextRequest } from "next/server";
import { readProxyBody, SubscriptionBodyError } from "@/lib/subscription-body";

type Context = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, context: Context) {
  const { path } = await context.params;
  const target = new URL(`/api/${path.join("/")}`, process.env.BACKEND_URL ?? "http://backend:3001");
  target.search = request.nextUrl.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");

  let body: ArrayBuffer | undefined;
  try {
    body = request.method === "GET" || request.method === "HEAD" ? undefined : await readProxyBody(request, target.pathname);
  } catch (error) {
    if (error instanceof SubscriptionBodyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  const response = await fetch(target, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const dynamic = "force-dynamic";
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
