import type { Knex } from "knex";
import { z } from "zod";
import { handleError, json } from "./http";
import { PushEndpointError, validatePushEndpointAddress } from "./push-security";
import { subscriptionEndpointInput, subscriptionInput } from "./subscription-input";

export const MAX_SUBSCRIPTION_BODY_BYTES = 4096;
export const SUBSCRIPTION_RATE_CAPACITY = 30;
const TOKEN_INTERVAL_MS = 2000;

// Shared across clients because forwarded IP headers are not a trusted identity.
// Constant memory; each server process has its own bucket.
export function createSubscriptionRateLimiter(now = Date.now) {
  let tokens = SUBSCRIPTION_RATE_CAPACITY;
  let lastRefill = now();
  return () => {
    const current = Math.max(now(), lastRefill);
    tokens = Math.min(SUBSCRIPTION_RATE_CAPACITY, tokens + (current - lastRefill) / TOKEN_INTERVAL_MS);
    lastRefill = current;
    if (tokens < 1) return Math.ceil((1 - tokens) * TOKEN_INTERVAL_MS / 1000);
    tokens -= 1;
    return 0;
  };
}

class SubscriptionRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function readSubscriptionBody(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) throw new SubscriptionRequestError("Content-Length が不正です。", 400);
    if (Number(length) > MAX_SUBSCRIPTION_BODY_BYTES) {
      throw new SubscriptionRequestError("入力サイズが上限を超えています。", 413);
    }
  }
  const reader = request.body?.getReader();
  if (!reader) throw new SubscriptionRequestError("JSON を指定してください。", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SUBSCRIPTION_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new SubscriptionRequestError("入力サイズが上限を超えています。", 413);
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof SubscriptionRequestError) throw error;
    throw new SubscriptionRequestError("JSON が不正です。", 400);
  } finally {
    reader.releaseLock();
  }
}

type SubscriptionDependencies = {
  getDatabase: () => Promise<Knex>;
  validateAddress?: (endpoint: string) => Promise<void>;
  rateLimit?: () => number;
};

export function createSubscriptionHandlers({
  getDatabase,
  validateAddress = validatePushEndpointAddress,
  rateLimit = createSubscriptionRateLimiter(),
}: SubscriptionDependencies) {
  function checkRate() {
    const retryAfter = rateLimit();
    return retryAfter > 0
      ? json({ error: "登録リクエストが多すぎます。しばらく待ってから再試行してください。" }, {
        status: 429,
        headers: { "Retry-After": String(retryAfter) },
      })
      : undefined;
  }

  function requestError(error: unknown) {
    if (error instanceof SubscriptionRequestError || error instanceof PushEndpointError) {
      return json({ error: error.message }, { status: error instanceof SubscriptionRequestError ? error.status : 400 });
    }
    return handleError(error);
  }

  return {
    async POST(request: Request) {
      const limited = checkRate();
      if (limited) return limited;
      try {
        const input = subscriptionInput.parse(await readSubscriptionBody(request));
        await validateAddress(input.endpoint);
        const database = await getDatabase();
        const existing = await database("subscriptions").where({ endpoint: input.endpoint }).first();
        if (existing) {
          await database("subscriptions").where({ endpoint: input.endpoint }).update({
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
          });
        } else {
          await database("subscriptions").insert({
            endpoint: input.endpoint,
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
            created_at: new Date().toISOString(),
          });
        }
        return json({ ok: true });
      } catch (error) {
        return requestError(error);
      }
    },
    async DELETE(request: Request) {
      const limited = checkRate();
      if (limited) return limited;
      try {
        const input = z.object({ endpoint: subscriptionEndpointInput }).parse(await readSubscriptionBody(request));
        const database = await getDatabase();
        await database("subscriptions").where({ endpoint: input.endpoint }).delete();
        return json({ ok: true });
      } catch (error) {
        return requestError(error);
      }
    },
  };
}
