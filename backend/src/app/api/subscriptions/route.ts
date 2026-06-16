import { NextRequest } from "next/server";
import { z } from "zod";
import { readyDb } from "@/lib/db";
import { handleError, json } from "@/lib/http";

const subscriptionInput = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export async function POST(request: NextRequest) {
  try {
    const input = subscriptionInput.parse(await request.json());
    const database = await readyDb();
    const now = new Date().toISOString();
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
        created_at: now,
      });
    }
    return json({ ok: true });
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const input = z.object({ endpoint: z.string().url() }).parse(await request.json());
    const database = await readyDb();
    await database("subscriptions").where({ endpoint: input.endpoint }).delete();
    return json({ ok: true });
  } catch (error) {
    return handleError(error);
  }
}
