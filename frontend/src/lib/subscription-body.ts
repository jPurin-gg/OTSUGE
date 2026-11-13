export const MAX_SUBSCRIPTION_BODY_BYTES = 4096;

export class SubscriptionBodyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// Apply the same limit before the frontend buffers a subscription request.
// Other API routes keep their existing request-body behavior.
export async function readProxyBody(request: Request, pathname: string): Promise<ArrayBuffer> {
  // Check the normalized upstream pathname: decoded catchall parameters can
  // contain delimiters or dot segments that change the URL's effective route.
  if (pathname !== "/api/subscriptions" || !["POST", "DELETE"].includes(request.method)) {
    return request.arrayBuffer();
  }

  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) throw new SubscriptionBodyError("Content-Length が不正です。", 400);
    if (Number(length) > MAX_SUBSCRIPTION_BODY_BYTES) {
      throw new SubscriptionBodyError("入力サイズが上限を超えています。", 413);
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SUBSCRIPTION_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new SubscriptionBodyError("入力サイズが上限を超えています。", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}
