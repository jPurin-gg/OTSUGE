"use client";

import { useOffline } from "@/lib/offline";

export function OfflineBanner() {
  const offline = useOffline();
  if (!offline) return null;
  return (
    <p role="status" className="bg-amber-300 px-5 py-3 text-center text-sm font-bold text-slate-950">
      オフラインです。通信が戻るまで、最新の情報の取得と設定の変更はできません。
    </p>
  );
}
