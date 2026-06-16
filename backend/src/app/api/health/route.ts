import { json } from "@/lib/http";
import { readyDb } from "@/lib/db";

export async function GET() {
  await readyDb();
  return json({ ok: true });
}
