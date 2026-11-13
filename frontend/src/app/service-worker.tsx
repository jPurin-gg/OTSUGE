"use client";

import { useEffect } from "react";
import { registerServiceWorker } from "@/lib/sw";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    registerServiceWorker().catch(() => {});
  }, []);
  return null;
}
