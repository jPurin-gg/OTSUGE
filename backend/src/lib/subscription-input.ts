import { ECDH } from "node:crypto";
import { z } from "zod";
import { validatePushEndpoint } from "./push-security";

export const MAX_ENDPOINT_LENGTH = 2048;

function decodeKey(value: string, length: number) {
  if (value.length !== Math.ceil(length * 8 / 6) && value.length !== Math.ceil(length / 3) * 4) return undefined;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  const canonical = decoded.toString("base64url");
  const padded = canonical + "=".repeat((4 - canonical.length % 4) % 4);
  if (decoded.length !== length || (value !== canonical && value !== padded)) return undefined;
  return decoded;
}

function isPublicKey(value: string) {
  const key = decodeKey(value, 65);
  if (!key || key[0] !== 4) return false;
  try {
    ECDH.convertKey(key, "prime256v1");
    return true;
  } catch {
    return false;
  }
}

export const subscriptionEndpointInput = z.string().max(MAX_ENDPOINT_LENGTH).refine((value) => {
  try {
    validatePushEndpoint(value);
    return true;
  } catch {
    return false;
  }
}, "対応する Push サービスの HTTPS endpoint を指定してください。");

export const subscriptionInput = z.object({
  endpoint: subscriptionEndpointInput,
  keys: z.object({
    p256dh: z.string().max(88).refine(isPublicKey, "有効な P-256 公開鍵を指定してください。")
      .transform((value) => value.replace(/=+$/, "")),
    auth: z.string().max(24).refine((value) => Boolean(decodeKey(value, 16)), "16 バイトの認証鍵を指定してください。")
      .transform((value) => value.replace(/=+$/, "")),
  }),
});
