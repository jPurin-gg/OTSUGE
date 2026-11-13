"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { api, formatTime, INVALID_RESPONSE_MESSAGE } from "@/lib/api";
import { isNetworkFailure, reportConnectivity, useOffline } from "@/lib/offline";
import { getSubscriptionStatus, subscribePush, unsubscribePush } from "@/lib/push";
import { formatDateTime, loadLastSchedules, parseSchedules, saveLastSchedules, Schedule } from "@/lib/schedules";

const NETWORK_FAILURE_MESSAGE = "通信できませんでした。電波の良い場所でもう一度お試しください。";

/**
 * 予定の表示状態。
 * - loading: まだ取得していない
 * - live: いま取得できた予定
 * - last: 取得に失敗したので、最後に取得できた予定を出している
 * - none: 取得に失敗し、出せる予定もない
 */
type ScheduleView = { state: "loading" | "live" | "last" | "none"; schedules: Schedule[]; fetchedAt: string; error: string };

export default function Home() {
  const [view, setView] = useState<ScheduleView>({ state: "loading", schedules: [], fetchedAt: "", error: "" });
  // null は確認前。端末の購読状態が分かるまで「未設定」とは表示しない。
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const offline = useOffline();
  const { schedules } = view;
  const pendingSchedules = schedules.filter((schedule) => !Boolean(schedule.sent));
  const nextSchedule = pendingSchedules[0];

  async function refresh() {
    // 購読状態は端末内の情報なので、通信の成否に関係なく反映する。
    getSubscriptionStatus().then(setSubscribed, () => setSubscribed(false));
    try {
      const data = await api<{ schedules?: unknown }>("/api/public/schedules");
      const latest = parseSchedules(data?.schedules);
      if (!latest) throw new Error(INVALID_RESPONSE_MESSAGE);
      reportConnectivity(true);
      saveLastSchedules(latest);
      setView({ state: "live", schedules: latest, fetchedAt: "", error: "" });
    } catch (error) {
      const networkFailure = isNetworkFailure(error);
      reportConnectivity(!networkFailure);
      // 通信できないときの案内は画面上部のオフライン表示に任せる。
      const reason = networkFailure ? "" : error instanceof Error ? error.message : "";
      const last = loadLastSchedules();
      setView(
        last
          ? { state: "last", schedules: last.schedules, fetchedAt: last.fetchedAt, error: reason }
          : { state: "none", schedules: [], fetchedAt: "", error: reason },
      );
    }
  }

  useEffect(() => {
    // Initial state is synchronized with the API and browser PushManager.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    // 回線が戻ったら取り直す。
    window.addEventListener("online", refresh);
    return () => window.removeEventListener("online", refresh);
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
      if (isNetworkFailure(error)) setMessage(NETWORK_FAILURE_MESSAGE);
      else setMessage(error instanceof Error ? error.message : "うまく処理できませんでした。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f6f8fb] text-slate-950">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-6 sm:py-10">
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 pb-5">
          <div className="flex min-w-0 items-center gap-3">
            <Image className="size-11 rounded-lg shadow-sm" src="/icon-192.png" width={44} height={44} alt="" unoptimized />
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
                <p className="text-3xl font-bold">
                  {subscribed === null ? "確認中" : subscribed ? "受け取り中" : "未設定"}
                </p>
                <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">
                  {subscribed === null
                    ? "この端末の受け取り状態を確認しています。"
                    : subscribed
                      ? "今日のお告げを待機しています。予定は下の一覧で確認できます。"
                      : "通知を許可すると、今日のどこかでOTSUGEからお告げが届きます。"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded-md bg-cyan-300 px-4 py-3 text-sm font-bold text-slate-950 shadow-sm transition hover:bg-cyan-200 disabled:opacity-40"
                  disabled={loading || subscribed !== false}
                  onClick={() => run("subscribe")}
                >
                  受け取る
                </button>
                <button
                  className="rounded-md border border-white/30 px-4 py-3 text-sm font-bold text-white transition hover:bg-white/10 disabled:opacity-40"
                  disabled={loading || subscribed !== true}
                  onClick={() => run("unsubscribe")}
                >
                  停止する
                </button>
              </div>
            </div>
            {message && <p className="mt-5 rounded-md bg-white/10 p-3 text-sm text-slate-100">{message}</p>}
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm font-bold text-slate-500">
              次のお告げ{view.state === "last" && `（${formatDateTime(view.fetchedAt)} 時点）`}
            </p>
            {view.state === "loading" || view.state === "none" ? (
              <>
                <p className="mt-3 text-3xl font-bold">{view.state === "loading" ? "確認中" : "不明"}</p>
                <p className="mt-3 text-sm leading-6 text-slate-500">
                  {view.state === "loading" ? "予定を読み込んでいます。" : "予定を取得できていません。"}
                </p>
              </>
            ) : nextSchedule ? (
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

          {view.state === "last" && (
            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-5 py-3 text-sm font-bold leading-6 text-amber-900">
              {!offline && `最新の予定を取得できませんでした。${view.error}`}
              最後に取得できた予定を表示しています（{formatDateTime(view.fetchedAt)} 取得）。
            </p>
          )}

          <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            {schedules.length === 0 && (
              <p className="px-5 py-10 text-slate-500">
                {view.state === "loading"
                  ? "読み込み中です。"
                  : view.state === "none"
                    ? offline
                      ? "オフラインのため、予定を取得できません。"
                      : `予定を取得できませんでした。${view.error}`
                    : "今日はまだ静かです。"}
              </p>
            )}
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
