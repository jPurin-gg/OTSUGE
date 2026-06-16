import { json } from "@/lib/http";

export async function GET() {
  return json({ publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "" });
}
