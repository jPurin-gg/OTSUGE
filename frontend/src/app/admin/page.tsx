"use client";

import { FormEvent, useEffect, useState } from "react";
import { ActionResult, createActionRunner, Notice } from "@/lib/admin-action";
import { api, describeError, formatTime, isUnauthorized, toDatetimeLocal } from "@/lib/api";

type NotificationItem = {
  id: number;
  message: string;
  start_time: string;
  end_time: string;
  count_per_day: number;
  min_interval_minutes: number;
  enabled: boolean | number;
};

type QuietHour = {
  id: number;
  start_time: string;
  end_time: string;
  enabled: boolean | number;
};

type Schedule = {
  id: number;
  notification_id: number;
  scheduled_at: string;
  sent: boolean | number;
  discarded: boolean | number;
  manually_modified: boolean | number;
  message: string;
};

type Stats = {
  subscriptionCount: number;
};

type DeliveryLog = {
  id: number;
  schedule_id: number | null;
  status: "sent" | "discarded";
  message: string;
  scheduled_at: string;
  sent_at: string;
  delivered_count: number;
  failed_count: number;
  removed_subscription_count: number;
};

type NotificationForm = Omit<NotificationItem, "id">;
type QuietForm = Omit<QuietHour, "id">;

const emptyNotification: NotificationForm = {
  message: "",
  start_time: "09:00",
  end_time: "22:00",
  count_per_day: 1,
  min_interval_minutes: 60,
  enabled: true,
};

const emptyQuiet: QuietForm = {
  start_time: "00:00",
  end_time: "08:00",
  enabled: true,
};

type AuthState = "checking" | "loggedOut" | "loggedIn";

// 処理中に無効化したボタンの見た目。
const disabledStyle = "disabled:cursor-not-allowed disabled:opacity-50";

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [auth, setAuth] = useState<AuthState>("checking");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [quietHours, setQuietHours] = useState<QuietHour[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [stats, setStats] = useState<Stats>({ subscriptionCount: 0 });
  const [deliveryLogs, setDeliveryLogs] = useState<DeliveryLog[]>([]);
  const [notificationForm, setNotificationForm] = useState<NotificationForm>(emptyNotification);
  const [editingNotificationId, setEditingNotificationId] = useState<number | null>(null);
  const [quietForm, setQuietForm] = useState<QuietForm>(emptyQuiet);
  const [editingQuietId, setEditingQuietId] = useState<number | null>(null);
  // state の setter は再レンダーをまたいで同一なので、runner は最初の1回だけ作る。
  const [run] = useState(() =>
    createActionRunner({
      setBusy,
      setNotice,
      onSessionExpired: (reason) => {
        // フォームの入力内容は残したままログイン画面に戻す。
        setAuth("loggedOut");
        setNotice({ kind: "error", text: reason });
      },
    }),
  );

  // 5つの API を読み込み、成功したものは反映する。失敗があれば 401 を優先して投げる。
  async function loadAll() {
    const results = await Promise.allSettled([
      api<{ notifications: NotificationItem[] }>("/api/admin/notifications"),
      api<{ quietHours: QuietHour[] }>("/api/admin/quiet-hours"),
      api<{ schedules: Schedule[] }>("/api/admin/schedules"),
      api<Stats>("/api/admin/stats"),
      api<{ deliveryLogs: DeliveryLog[] }>("/api/admin/delivery-logs"),
    ]);
    const [notificationData, quietData, scheduleData, statsData, deliveryLogData] = results;
    if (notificationData.status === "fulfilled") setNotifications(notificationData.value.notifications);
    if (quietData.status === "fulfilled") setQuietHours(quietData.value.quietHours);
    if (scheduleData.status === "fulfilled") setSchedules(scheduleData.value.schedules);
    if (statsData.status === "fulfilled") setStats(statsData.value);
    if (deliveryLogData.status === "fulfilled") setDeliveryLogs(deliveryLogData.value.deliveryLogs);
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
    if (failures.length > 0) throw failures.find(isUnauthorized) ?? failures[0];
  }

  // 変更系の操作のあとに一覧を読み直す。変更自体は成功しているので、読み直しの失敗は「失敗」と区別して伝える。
  async function reloadAfter(successText: string): Promise<ActionResult> {
    try {
      await loadAll();
      return successText;
    } catch (error) {
      if (isUnauthorized(error)) throw error;
      return {
        kind: "error",
        text: `${successText}\nただし、最新の状態を読み込めませんでした。「更新」を押してください。\n${describeError(error)}`,
      };
    }
  }

  useEffect(() => {
    // ログイン判定は 401 かどうかだけで行う。401 以外の失敗はログイン済みとして画面を出し、エラーを表示する。
    let active = true;
    // Initial admin state is loaded from the backend.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll().then(
      () => {
        if (active) setAuth("loggedIn");
      },
      (error: unknown) => {
        if (!active) return;
        if (isUnauthorized(error)) {
          setAuth("loggedOut");
          return;
        }
        setAuth("loggedIn");
        setNotice({
          kind: "error",
          text: `読み込みに失敗しました。「更新」を押して読み込み直してください。\n${describeError(error)}`,
        });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  async function login(event: FormEvent) {
    event.preventDefault();
    // ここでの 401 は合言葉の誤りなので、セッション切れとしては扱わない。
    const loggedIn = await run({ label: "ログイン", sessionExpiryOn401: false }, async () => {
      await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) });
      setPassword("");
    });
    if (!loggedIn) return;
    setAuth("loggedIn");
    await run({ label: "読み込み" }, async () => {
      await loadAll();
    });
  }

  async function logout() {
    await run({ label: "ログアウト" }, async () => {
      await api("/api/admin/logout", { method: "POST" });
      setAuth("loggedOut");
      setNotifications([]);
      setQuietHours([]);
      setSchedules([]);
      setStats({ subscriptionCount: 0 });
      setDeliveryLogs([]);
      setNotificationForm(emptyNotification);
      setEditingNotificationId(null);
      setQuietForm(emptyQuiet);
      setEditingQuietId(null);
      return "ログアウトしました。";
    });
  }

  async function refresh() {
    await run({ label: "読み込み" }, async () => {
      await loadAll();
      return "最新の状態にしました。";
    });
  }

  async function saveNotification(event: FormEvent) {
    event.preventDefault();
    const editingId = editingNotificationId;
    await run({ label: editingId ? "お告げの更新" : "お告げの追加" }, async () => {
      const path = editingId ? `/api/admin/notifications/${editingId}` : "/api/admin/notifications";
      await api(path, {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify(notificationForm),
      });
      // 入力内容を消すのは保存に成功したときだけ。
      setNotificationForm(emptyNotification);
      setEditingNotificationId(null);
      return reloadAfter(editingId ? "お告げを更新しました。" : "お告げを追加しました。");
    });
  }

  async function saveQuietHour(event: FormEvent) {
    event.preventDefault();
    const editingId = editingQuietId;
    await run({ label: editingId ? "静かにする時間の更新" : "静かにする時間の追加" }, async () => {
      const path = editingId ? `/api/admin/quiet-hours/${editingId}` : "/api/admin/quiet-hours";
      await api(path, {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify(quietForm),
      });
      setQuietForm(emptyQuiet);
      setEditingQuietId(null);
      return reloadAfter(editingId ? "静かにする時間を更新しました。" : "静かにする時間を追加しました。");
    });
  }

  async function generateSchedules() {
    await run({ label: "今日のお告げの生成" }, async () => {
      const result = await api<{ generated: number; warnings: string[] }>("/api/admin/schedules", { method: "POST" });
      return reloadAfter([`今日のお告げを${result.generated}件つくりました。`, ...result.warnings].join("\n"));
    });
  }

  async function updateSchedule(id: number, value: string, current: string) {
    // 値を変えずに欄を離れただけなら送らない（手動編集扱いにしない）。
    if (value === current) return;
    await run({ label: "配信時刻の変更" }, async () => {
      const date = new Date(value);
      if (!value || Number.isNaN(date.getTime())) throw new Error("配信時刻を正しく入力してください。");
      await api(`/api/admin/schedules/${id}`, {
        method: "PUT",
        body: JSON.stringify({ scheduled_at: date.toISOString() }),
      });
      return reloadAfter("配信時刻を変更しました。");
    });
  }

  async function remove(path: string, label: string) {
    if (busy) return;
    if (!window.confirm(`${label}を削除します。よろしいですか？`)) return;
    await run({ label: `${label}の削除` }, async () => {
      await api(path, { method: "DELETE" });
      return reloadAfter(`${label}を削除しました。`);
    });
  }

  async function sendNow(id: number) {
    await run({ label: "今すぐ送る" }, async () => {
      const result = await api<{ delivered: number; failed: number; removed: number }>(`/api/admin/schedules/${id}/send`, {
        method: "POST",
      });
      return reloadAfter(
        `今すぐ送りました。成功: ${result.delivered}件 / 失敗: ${result.failed}件 / 購読解除: ${result.removed}件`,
      );
    });
  }

  if (auth === "checking") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md items-center justify-center px-5">
        <p className="text-slate-500" role="status">
          確認中…
        </p>
      </main>
    );
  }

  if (auth === "loggedOut") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md items-center px-5">
        <form className="w-full rounded-3xl bg-white p-8 shadow-sm" onSubmit={login}>
          <h1 className="text-3xl font-bold">管理画面</h1>
          <p className="mt-2 text-slate-500">合言葉を入れてください。</p>
          <input
            className="mt-6 w-full rounded-2xl border border-slate-200 px-4 py-3"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="ADMIN_PASSWORD"
          />
          <button
            className={`mt-4 w-full rounded-2xl bg-slate-950 px-4 py-3 font-bold text-white ${disabledStyle}`}
            disabled={busy}
          >
            {busy ? "ログイン中…" : "ログイン"}
          </button>
          {notice && <NoticeBanner className="mt-4" notice={notice} onClose={() => setNotice(null)} />}
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-8" aria-busy={busy}>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-cyan-700">OTSUGE ADMIN</p>
          <h1 className="text-3xl font-bold">お告げ管理</h1>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            className={`rounded-full bg-white px-4 py-2 font-bold shadow-sm ${disabledStyle}`}
            onClick={refresh}
            disabled={busy}
          >
            更新
          </button>
          <button
            className={`rounded-full bg-slate-950 px-4 py-2 font-bold text-white ${disabledStyle}`}
            onClick={generateSchedules}
            disabled={busy}
          >
            今日のお告げを生成
          </button>
          <button
            className={`rounded-full bg-white px-4 py-2 font-bold text-slate-600 shadow-sm ${disabledStyle}`}
            onClick={logout}
            disabled={busy}
          >
            ログアウト
          </button>
        </div>
      </header>
      {busy && (
        <p className="text-sm text-slate-500" role="status">
          処理中…
        </p>
      )}
      {notice && <NoticeBanner notice={notice} onClose={() => setNotice(null)} />}

      <section className="grid gap-3 sm:grid-cols-3">
        <StatCard label="購読者" value={`${stats.subscriptionCount}件`} />
        <StatCard label="今日の未送信" value={`${schedules.filter((schedule) => !Boolean(schedule.sent)).length}件`} />
        <StatCard label="最近のログ" value={`${deliveryLogs.length}件`} />
      </section>

      <section className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <form className="rounded-3xl bg-white p-6 shadow-sm" onSubmit={saveNotification}>
          <h2 className="text-xl font-bold">{editingNotificationId ? "お告げを編集" : "お告げを作成"}</h2>
          <label className="mt-4 block text-sm font-bold">本文</label>
          <textarea
            className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3"
            value={notificationForm.message}
            onChange={(event) => setNotificationForm({ ...notificationForm, message: event.target.value })}
            maxLength={200}
            required
          />
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Field label="開始">
              <input
                className="input"
                type="time"
                value={notificationForm.start_time}
                onChange={(event) => setNotificationForm({ ...notificationForm, start_time: event.target.value })}
                required
              />
            </Field>
            <Field label="終了">
              <input
                className="input"
                type="time"
                value={notificationForm.end_time}
                onChange={(event) => setNotificationForm({ ...notificationForm, end_time: event.target.value })}
                required
              />
            </Field>
            <Field label="1日の回数">
              <input
                className="input"
                type="number"
                min="1"
                max="100"
                value={notificationForm.count_per_day}
                onChange={(event) =>
                  setNotificationForm({ ...notificationForm, count_per_day: Number(event.target.value) })
                }
              />
            </Field>
            <Field label="最低間隔（分）">
              <input
                className="input"
                type="number"
                min="0"
                max="1440"
                value={notificationForm.min_interval_minutes}
                onChange={(event) =>
                  setNotificationForm({ ...notificationForm, min_interval_minutes: Number(event.target.value) })
                }
              />
            </Field>
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm font-bold">
            <input
              type="checkbox"
              checked={Boolean(notificationForm.enabled)}
              onChange={(event) => setNotificationForm({ ...notificationForm, enabled: event.target.checked })}
            />
            有効
          </label>
          <button className={`mt-5 rounded-2xl bg-slate-950 px-5 py-3 font-bold text-white ${disabledStyle}`} disabled={busy}>
            {editingNotificationId ? "更新" : "追加"}
          </button>
        </form>

        <section className="rounded-3xl bg-white p-6 shadow-sm">
          <h2 className="text-xl font-bold">お告げ一覧</h2>
          <div className="mt-4 divide-y divide-slate-100">
            {notifications.map((item) => (
              <div key={item.id} className="py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-bold">{item.message}</p>
                    <p className="text-sm text-slate-500">
                      {item.start_time}-{item.end_time} / {item.count_per_day}回 / {item.min_interval_minutes}分間隔 /{" "}
                      {Boolean(item.enabled) ? "有効" : "無効"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      className={`rounded-full bg-slate-100 px-3 py-1 text-sm font-bold ${disabledStyle}`}
                      disabled={busy}
                      onClick={() => {
                        setEditingNotificationId(item.id);
                        setNotificationForm({
                          message: item.message,
                          start_time: item.start_time,
                          end_time: item.end_time,
                          count_per_day: item.count_per_day,
                          min_interval_minutes: item.min_interval_minutes,
                          enabled: Boolean(item.enabled),
                        });
                      }}
                    >
                      編集
                    </button>
                    <button
                      className={`rounded-full bg-red-50 px-3 py-1 text-sm font-bold text-red-700 ${disabledStyle}`}
                      disabled={busy}
                      onClick={() => remove(`/api/admin/notifications/${item.id}`, "お告げ")}
                    >
                      削除
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </section>

      <section className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
        <form className="rounded-3xl bg-white p-6 shadow-sm" onSubmit={saveQuietHour}>
          <h2 className="text-xl font-bold">静かにする時間</h2>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Field label="開始">
              <input
                className="input"
                type="time"
                value={quietForm.start_time}
                onChange={(event) => setQuietForm({ ...quietForm, start_time: event.target.value })}
                required
              />
            </Field>
            <Field label="終了">
              <input
                className="input"
                type="time"
                value={quietForm.end_time}
                onChange={(event) => setQuietForm({ ...quietForm, end_time: event.target.value })}
                required
              />
            </Field>
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm font-bold">
            <input
              type="checkbox"
              checked={Boolean(quietForm.enabled)}
              onChange={(event) => setQuietForm({ ...quietForm, enabled: event.target.checked })}
            />
            有効
          </label>
          <button className={`mt-5 rounded-2xl bg-slate-950 px-5 py-3 font-bold text-white ${disabledStyle}`} disabled={busy}>
            {editingQuietId ? "更新" : "追加"}
          </button>
          <div className="mt-4 space-y-2">
            {quietHours.map((quiet) => (
              <div key={quiet.id} className="flex items-center justify-between rounded-2xl bg-slate-50 p-3">
                <span>
                  {quiet.start_time}-{quiet.end_time} / {Boolean(quiet.enabled) ? "有効" : "無効"}
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    className={`text-sm font-bold ${disabledStyle}`}
                    disabled={busy}
                    onClick={() => {
                      setEditingQuietId(quiet.id);
                      setQuietForm({
                        start_time: quiet.start_time,
                        end_time: quiet.end_time,
                        enabled: Boolean(quiet.enabled),
                      });
                    }}
                  >
                    編集
                  </button>
                  <button
                    type="button"
                    className={`text-sm font-bold text-red-700 ${disabledStyle}`}
                    disabled={busy}
                    onClick={() => remove(`/api/admin/quiet-hours/${quiet.id}`, "静かにする時間")}
                  >
                    削除
                  </button>
                </span>
              </div>
            ))}
          </div>
        </form>

        <section className="rounded-3xl bg-white p-6 shadow-sm">
          <h2 className="text-xl font-bold">今日の配信予定</h2>
          <div className="mt-4 divide-y divide-slate-100">
            {schedules.length === 0 && <p className="py-6 text-slate-500">今日の予定はまだありません。</p>}
            {schedules.map((schedule) => (
              <div key={schedule.id} className="grid gap-3 py-4 md:grid-cols-[120px_1fr_auto] md:items-center">
                <div>
                  <p className="font-mono text-lg font-bold">{formatTime(schedule.scheduled_at)}</p>
                  <p className="text-xs text-slate-500">
                    {Boolean(schedule.sent) ? (Boolean(schedule.discarded) ? "破棄" : "送信済み") : "未送信"}
                    {Boolean(schedule.manually_modified) ? " / 手動編集" : ""}
                  </p>
                </div>
                <div>
                  <p className="font-bold">{schedule.message}</p>
                  <input
                    className="mt-2 rounded-xl border border-slate-200 px-3 py-2"
                    type="datetime-local"
                    defaultValue={toDatetimeLocal(schedule.scheduled_at)}
                    onBlur={(event) =>
                      updateSchedule(schedule.id, event.target.value, toDatetimeLocal(schedule.scheduled_at))
                    }
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    className={`rounded-full bg-cyan-100 px-3 py-2 text-sm font-bold text-cyan-900 ${disabledStyle}`}
                    disabled={busy}
                    onClick={() => sendNow(schedule.id)}
                  >
                    今すぐ送る
                  </button>
                  <button
                    className={`rounded-full bg-red-50 px-3 py-2 text-sm font-bold text-red-700 ${disabledStyle}`}
                    disabled={busy}
                    onClick={() => remove(`/api/admin/schedules/${schedule.id}`, "配信予定")}
                  >
                    削除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </section>

      <section className="rounded-3xl bg-white p-6 shadow-sm">
        <h2 className="text-xl font-bold">最近の送信ログ</h2>
        <div className="mt-4 divide-y divide-slate-100">
          {deliveryLogs.length === 0 && <p className="py-6 text-slate-500">送信ログはまだありません。</p>}
          {deliveryLogs.map((log) => (
            <div key={log.id} className="grid gap-3 py-4 md:grid-cols-[160px_1fr_auto] md:items-center">
              <div>
                <p className="font-mono text-sm font-bold">{formatTime(log.sent_at)}</p>
                <p className="text-xs text-slate-500">予定 {formatTime(log.scheduled_at)}</p>
              </div>
              <div>
                <p className="font-bold">{log.message}</p>
                <p className="text-sm text-slate-500">
                  成功 {log.delivered_count} / 失敗 {log.failed_count} / 購読解除 {log.removed_subscription_count}
                </p>
              </div>
              <LogStatus status={log.status} />
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function NoticeBanner({
  notice,
  onClose,
  className = "",
}: {
  notice: Notice;
  onClose: () => void;
  className?: string;
}) {
  const tone = notice.kind === "error" ? "bg-red-50 text-red-800" : "bg-cyan-50 text-cyan-900";
  return (
    <div
      className={`flex items-start justify-between gap-3 rounded-2xl p-4 text-sm ${tone} ${className}`}
      role={notice.kind === "error" ? "alert" : "status"}
    >
      <p className="whitespace-pre-line">{notice.text}</p>
      <button type="button" className="shrink-0 font-bold opacity-70 hover:opacity-100" onClick={onClose}>
        閉じる
      </button>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <section className="rounded-3xl bg-white p-5 shadow-sm">
      <p className="text-sm font-bold text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-bold">{value}</p>
    </section>
  );
}

function LogStatus({ status }: { status: DeliveryLog["status"] }) {
  if (status === "discarded") {
    return <span className="w-fit rounded-full bg-red-50 px-3 py-1 text-xs font-bold text-red-700">破棄</span>;
  }
  return <span className="w-fit rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">送信済み</span>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm font-bold">
      {label}
      <div className="mt-2 [&_.input]:w-full [&_.input]:rounded-2xl [&_.input]:border [&_.input]:border-slate-200 [&_.input]:px-4 [&_.input]:py-3">
        {children}
      </div>
    </label>
  );
}
