"use client";

import { useEffect, useState } from "react";

/** Chromium 系のブラウザが「インストールできる」と判断したときに出すイベント。標準の型定義にはない。 */
type BeforeInstallPromptEvent = Event & { prompt: () => Promise<unknown> };

/**
 * Android / PC の Chromium 系ブラウザ向けの「ホーム画面に追加」ボタン。
 * ブラウザが beforeinstallprompt を出したときだけ表示する（iOS や追加済みの場合は何も出さない）。
 */
export function InstallButton() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      // ブラウザ独自の案内は出さず、このボタンから確認を出す。
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setPromptEvent(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!promptEvent) return null;

  return (
    <button
      className="mt-4 rounded-md border border-white/30 px-3 py-2 text-xs font-bold text-white transition hover:bg-white/10"
      onClick={() => {
        // 1つのイベントで確認を出せるのは1回だけ。断られた場合は、ブラウザが次のイベントを出すまで隠す。
        setPromptEvent(null);
        promptEvent.prompt().catch(() => {});
      }}
    >
      ホーム画面に追加する
    </button>
  );
}
