"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { api, formatTime } from "@/lib/api";
import { readPushEnvironment, subscribePush, unsubscribePush } from "@/lib/push";
import { describePushError, getPushCardView, type PushEnvironment } from "@/lib/push-state";
import { PushCard } from "./push-card";

type Schedule = {
  id: number;
  scheduled_at: string;
  message: string;
  sent: boolean | number;
  discarded: boolean | number;
};

export default function Home() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  // null は確認前。端末の状態が分かるまでは「未設定」とも「非対応」とも表示しない。
  const [pushEnvironment, setPushEnvironment] = useState<PushEnvironment | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const pendingSchedules = schedules.filter((schedule) => !Boolean(schedule.sent));
  const nextSchedule = pendingSchedules[0];

  async function refreshPush() {
    setPushEnvironment(await readPushEnvironment());
  }

  async function refresh() {
    // 通知の状態は端末内の情報なので、予定の取得より先に、その成否に関係なく反映する。
    setPushEnvironment(await readPushEnvironment());
    const data = await api<{ schedules: Schedule[] }>("/api/public/schedules");
    setSchedules(data.schedules);
  }

  useEffect(() => {
    // Initial state is synchronized with the API and browser PushManager.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch((error) => setMessage(error.message));
  }, []);

  useEffect(() => {
    // 設定アプリなどで通知の許可を変えて戻ってきたときに、カードの状態を取り直す。
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshPush();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
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
      console.error(error);
      setMessage(describePushError(error));
      // 許可ダイアログでブロックされた場合などに、カードを新しい状態（ブロック中の案内）へ切り替える。
      await refreshPush();
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
          <PushCard
            view={getPushCardView(pushEnvironment)}
            loading={loading}
            message={message}
            onSubscribe={() => run("subscribe")}
            onUnsubscribe={() => run("unsubscribe")}
          />

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
