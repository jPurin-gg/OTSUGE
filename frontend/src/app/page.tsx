"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { formatTime } from "@/lib/api";
import {
  describeLoadError,
  failed,
  fetchTodaySchedules,
  initialLoad,
  loaded,
  type Loadable,
  reloading,
  SUBSCRIPTION_ERROR_MESSAGE,
  subscriptionView,
  type Schedule,
} from "@/lib/home-state";
import { getSubscriptionStatus, subscribePush, unsubscribePush } from "@/lib/push";

/** 購読・停止の結果。成功とエラーで見た目を分ける。 */
type Notice = { kind: "success" | "error"; text: string };

export default function Home() {
  // 予定と購読状態は、それぞれ「読み込み中 / 失敗 / 取得済み」を持つ。取得できるまでは空の状態として描画しない。
  const [today, setToday] = useState<Loadable<Schedule[]>>(initialLoad);
  const [subscription, setSubscription] = useState<Loadable<boolean>>(initialLoad);
  const [notice, setNotice] = useState<Notice | null>(null);
  // 購読・停止の処理中。
  const [loading, setLoading] = useState(false);
  // 最後に始めた取得の番号。先に始めた取得が後から終わっても、新しい結果を上書きさせない。
  const latestRefresh = useRef(0);

  const schedules = today.value ?? [];
  const pendingSchedules = schedules.filter((schedule) => !Boolean(schedule.sent));
  const nextSchedule = pendingSchedules[0];
  const refreshing = today.status === "loading" || subscription.status === "loading";
  const refreshFailed = !refreshing && (today.status === "error" || subscription.status === "error");
  const card = subscriptionView(subscription);

  // 予定と購読状態を取り直す。失敗は例外にせず、それぞれの状態に入れる。
  async function refresh() {
    const id = ++latestRefresh.current;
    const isLatest = () => id === latestRefresh.current;
    setToday(reloading);
    setSubscription(reloading);

    // 購読状態は端末内の情報なので、予定の取得を待たず、その成否にも関係なく反映する。
    const subscriptionChecked = getSubscriptionStatus().then(
      (subscribed) => {
        if (isLatest()) setSubscription(loaded(subscribed));
      },
      (error) => {
        console.error(error);
        if (isLatest()) setSubscription((state) => failed(state, SUBSCRIPTION_ERROR_MESSAGE));
      },
    );
    try {
      const latest = await fetchTodaySchedules();
      if (isLatest()) setToday(loaded(latest));
    } catch (error) {
      console.error(error);
      if (isLatest()) setToday((state) => failed(state, describeLoadError(error)));
    }
    await subscriptionChecked;
  }

  useEffect(() => {
    refresh();
  }, []);

  async function run(action: "subscribe" | "unsubscribe") {
    setLoading(true);
    setNotice(null);
    try {
      if (action === "subscribe") {
        await subscribePush();
        setNotice({ kind: "success", text: "お告げを受け取れるようになりました。" });
      } else {
        await unsubscribePush();
        setNotice({ kind: "success", text: "お告げの受け取りを止めました。" });
      }
      await refresh();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "うまく処理できませんでした。" });
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
          <div className="flex shrink-0 flex-col items-end gap-1">
            <button
              className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-bold shadow-sm transition hover:border-slate-400 disabled:opacity-50"
              onClick={refresh}
              disabled={loading || refreshing}
            >
              {refreshing ? "更新中…" : "更新"}
            </button>
            {refreshFailed && <p className="text-xs font-bold text-rose-700">取得に失敗</p>}
          </div>
        </header>

        <section className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-lg bg-slate-950 p-6 text-white shadow-sm">
            <p className="text-sm font-bold text-amber-300">現在の状態</p>
            <div className="mt-4 flex flex-wrap items-end justify-between gap-5">
              <div>
                <p className="text-3xl font-bold">{card.title}</p>
                <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">{card.description}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded-md bg-cyan-300 px-4 py-3 text-sm font-bold text-slate-950 shadow-sm transition hover:bg-cyan-200 disabled:opacity-40"
                  disabled={loading || !card.canSubscribe}
                  onClick={() => run("subscribe")}
                >
                  受け取る
                </button>
                <button
                  className="rounded-md border border-white/30 px-4 py-3 text-sm font-bold text-white transition hover:bg-white/10 disabled:opacity-40"
                  disabled={loading || !card.canUnsubscribe}
                  onClick={() => run("unsubscribe")}
                >
                  停止する
                </button>
              </div>
            </div>
            {notice?.kind === "success" && (
              <p role="status" className="mt-5 rounded-md bg-white/10 p-3 text-sm text-slate-100">
                {notice.text}
              </p>
            )}
            {notice?.kind === "error" && (
              <p role="alert" className="mt-5 rounded-md border border-rose-300/60 bg-rose-500/20 p-3 text-sm text-rose-50">
                {notice.text}
              </p>
            )}
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
            ) : today.value ? (
              <>
                <p className="mt-3 text-3xl font-bold">静かです</p>
                <p className="mt-3 text-sm leading-6 text-slate-500">未送信の予定はありません。</p>
              </>
            ) : today.status === "error" ? (
              <>
                <p className="mt-3 text-3xl font-bold">不明</p>
                <p className="mt-3 text-sm leading-6 text-slate-500">予定を取得できていません。</p>
              </>
            ) : (
              <>
                <p className="mt-3 text-3xl font-bold">確認中</p>
                <p className="mt-3 text-sm leading-6 text-slate-500">予定を読み込んでいます。</p>
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
              {today.value
                ? `未送信 ${pendingSchedules.length} / 全${schedules.length}`
                : today.status === "error"
                  ? "取得できていません"
                  : "読み込み中"}
            </p>
          </div>

          {today.status === "error" && (
            <div role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-5 text-rose-900">
              <p className="font-bold">
                {today.value
                  ? "最新の予定を取得できませんでした。前回取得した内容を表示しています。"
                  : "今日の予定を取得できませんでした。"}
              </p>
              <p className="mt-1 text-sm leading-6">{today.error}</p>
              <button
                className="mt-3 rounded-md border border-rose-300 bg-white px-3 py-2 text-sm font-bold shadow-sm transition hover:border-rose-400 disabled:opacity-50"
                onClick={refresh}
                disabled={loading}
              >
                再試行
              </button>
            </div>
          )}

          {(today.value || today.status === "loading") && (
            <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
              {!today.value && <p className="px-5 py-10 text-slate-500">予定を読み込んでいます…</p>}
              {today.value && schedules.length === 0 && <p className="px-5 py-10 text-slate-500">今日はまだ静かです。</p>}
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
          )}
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
