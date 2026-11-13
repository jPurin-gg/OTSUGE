import { handleError, json } from "@/lib/http";
import { readyDb } from "@/lib/db";

export async function GET() {
  try {
    await readyDb();
    return json({ ok: true });
  } catch (error) {
    return handleError(error);
  }
}
