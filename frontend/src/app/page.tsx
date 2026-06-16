"use client";

import Image from "next/image";
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
  const pendingSchedules = schedules.filter((schedule) => !Boolean(schedule.sent));
  const nextSchedule = pendingSchedules[0];

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
        setMessage("お告げを受け取れるようになりました。");
      } else {
        await unsubscribePush();
        setMessage("お告げの受け取りを止めました。");
      }
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "うまく処理できませんでした。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f6f8fb] text-slate-950">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-6 sm:py-10">
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 pb-5">
          <div className="flex min-w-0 items-center gap-3">
            <Image className="size-11 rounded-lg shadow-sm" src="/icon-192.png" width={44} height={44} alt="" />
            <div className="min-w-0">
              <p className="text-xs font-bold text-cyan-700">OTSUGE</p>
              <h1 className="text-2xl font-bold sm:text-3xl">忘れたころに届く。</h1>
            </div>
          </div>
          <button
            className="shrink-0 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-bold shadow-sm transition hover:border-slate-400 disabled:opacity-50"
            onClick={refresh}
            disabled={loading}
          >
            更新
          </button>
        </header>

        <section className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-lg bg-slate-950 p-6 text-white shadow-sm">
            <p className="text-sm font-bold text-amber-300">現在の状態</p>
            <div className="mt-4 flex flex-wrap items-end justify-between gap-5">
              <div>
                <p className="text-3xl font-bold">{subscribed ? "受け取り中" : "未設定"}</p>
                <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">
                  {subscribed
                    ? "今日のお告げを待機しています。予定は下の一覧で確認できます。"
                    : "通知を許可すると、今日のどこかでOTSUGEからお告げが届きます。"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded-md bg-cyan-300 px-4 py-3 text-sm font-bold text-slate-950 shadow-sm transition hover:bg-cyan-200 disabled:opacity-40"
                  disabled={loading || subscribed}
                  onClick={() => run("subscribe")}
                >
                  受け取る
                </button>
                <button
                  className="rounded-md border border-white/30 px-4 py-3 text-sm font-bold text-white transition hover:bg-white/10 disabled:opacity-40"
                  disabled={loading || !subscribed}
                  onClick={() => run("unsubscribe")}
                >
                  停止する
                </button>
              </div>
            </div>
            {message && <p className="mt-5 rounded-md bg-white/10 p-3 text-sm text-slate-100">{message}</p>}
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm font-bold text-slate-500">次のお告げ</p>
            {nextSchedule ? (
              <>
                <time className="mt-3 block font-mono text-5xl font-bold text-slate-950">
                  {formatTime(nextSchedule.scheduled_at)}
                </time>
                <p className="mt-3 text-base font-bold leading-7">{nextSchedule.message}</p>
              </>
            ) : (
              <>
                <p className="mt-3 text-3xl font-bold">静かです</p>
                <p className="mt-3 text-sm leading-6 text-slate-500">未送信の予定はありません。</p>
              </>
            )}
          </div>
        </section>

        <section>
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-sm font-bold text-cyan-700">TODAY</p>
              <h2 className="text-2xl font-bold">今日のお告げ</h2>
            </div>
            <p className="text-sm font-bold text-slate-500">
              未送信 {pendingSchedules.length} / 全{schedules.length}
            </p>
          </div>

          <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            {schedules.length === 0 && <p className="px-5 py-10 text-slate-500">今日はまだ静かです。</p>}
            {schedules.map((schedule) => (
              <div
                key={schedule.id}
                className="grid gap-3 border-b border-slate-100 px-5 py-4 last:border-b-0 sm:grid-cols-[84px_1fr_auto] sm:items-center"
              >
                <time className="font-mono text-xl font-bold text-slate-950">{formatTime(schedule.scheduled_at)}</time>
                <p className="min-w-0 text-base leading-7">{schedule.message}</p>
                <StatusBadge sent={Boolean(schedule.sent)} discarded={Boolean(schedule.discarded)} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function StatusBadge({ sent, discarded }: { sent: boolean; discarded: boolean }) {
  if (!sent) {
    return <span className="w-fit rounded-md bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">待機中</span>;
  }
  if (discarded) {
    return <span className="w-fit rounded-md bg-rose-50 px-3 py-1 text-xs font-bold text-rose-700">破棄</span>;
  }
  return <span className="w-fit rounded-md bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">送信済</span>;
}
