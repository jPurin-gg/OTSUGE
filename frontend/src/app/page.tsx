"use client";

import { useEffect, useState } from "react";
import { api, formatTime } from "@/lib/api";
import { getSubscriptionStatus, subscribePush, unsubscribePush } from "@/lib/push";

type Schedule = {
  id: number;
  scheduled_at: string;
  message: string;
  sent: boolean | number;
  discarded: boolean | number;
};

export default function Home() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [subscribed, setSubscribed] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function refresh() {
    const data = await api<{ schedules: Schedule[] }>("/api/public/schedules");
    setSchedules(data.schedules);
    setSubscribed(await getSubscriptionStatus());
  }

  useEffect(() => {
    // Initial state is synchronized with the API and browser PushManager.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch((error) => setMessage(error.message));
  }, []);

  async function run(action: "subscribe" | "unsubscribe") {
    setLoading(true);
    setMessage("");
    try {
      if (action === "subscribe") {
        await subscribePush();
        setMessage("通知を購読しました。");
      } else {
        await unsubscribePush();
        setMessage("通知購読を解除しました。");
      }
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "処理に失敗しました。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-5 py-10">
      <section className="rounded-3xl bg-slate-950 p-8 text-white shadow-xl">
        <p className="text-sm font-semibold text-cyan-300">OTSUGE</p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight">ちょうど忘れた頃に通知します。</h1>
        <p className="mt-4 text-slate-300">
          ホーム画面に追加し、通知を許可すると、管理者が登録した通知をランダムなタイミングで受け取れます。
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            className="rounded-full bg-cyan-300 px-5 py-3 font-bold text-slate-950 disabled:opacity-50"
            disabled={loading || subscribed}
            onClick={() => run("subscribe")}
          >
            通知を購読する
          </button>
          <button
            className="rounded-full border border-white/30 px-5 py-3 font-bold disabled:opacity-50"
            disabled={loading || !subscribed}
            onClick={() => run("unsubscribe")}
          >
            購読解除
          </button>
        </div>
        <p className="mt-4 text-sm text-slate-300">
          状態: {subscribed ? "購読中" : "未購読"} / iPhoneでは iOS 16.4以降、Safari、ホーム画面追加が前提です。
        </p>
        {message && <p className="mt-4 rounded-2xl bg-white/10 p-3 text-sm">{message}</p>}
      </section>

      <section className="rounded-3xl bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-2xl font-bold">今日の通知予定</h2>
          <button className="rounded-full bg-slate-100 px-4 py-2 text-sm font-bold" onClick={refresh}>
            更新
          </button>
        </div>
        <div className="mt-5 divide-y divide-slate-100">
          {schedules.length === 0 && <p className="py-8 text-slate-500">今日の予定はまだありません。</p>}
          {schedules.map((schedule) => (
            <div key={schedule.id} className="flex items-center gap-4 py-4">
              <time className="w-16 font-mono text-lg font-bold">{formatTime(schedule.scheduled_at)}</time>
              <p className="flex-1">{schedule.message}</p>
              {Boolean(schedule.sent) && (
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">
                  {Boolean(schedule.discarded) ? "破棄" : "送信済"}
                </span>
              )}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
