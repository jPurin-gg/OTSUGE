"use client";

import { FormEvent, useEffect, useState } from "react";
import { api, formatTime, toDatetimeLocal } from "@/lib/api";

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

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);
  const [message, setMessage] = useState("");
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [quietHours, setQuietHours] = useState<QuietHour[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [stats, setStats] = useState<Stats>({ subscriptionCount: 0 });
  const [deliveryLogs, setDeliveryLogs] = useState<DeliveryLog[]>([]);
  const [notificationForm, setNotificationForm] = useState<NotificationForm>(emptyNotification);
  const [editingNotificationId, setEditingNotificationId] = useState<number | null>(null);
  const [quietForm, setQuietForm] = useState<QuietForm>(emptyQuiet);
  const [editingQuietId, setEditingQuietId] = useState<number | null>(null);

  async function loadAll() {
    const [notificationData, quietData, scheduleData, statsData, deliveryLogData] = await Promise.all([
      api<{ notifications: NotificationItem[] }>("/api/admin/notifications"),
      api<{ quietHours: QuietHour[] }>("/api/admin/quiet-hours"),
      api<{ schedules: Schedule[] }>("/api/admin/schedules"),
      api<Stats>("/api/admin/stats"),
      api<{ deliveryLogs: DeliveryLog[] }>("/api/admin/delivery-logs"),
    ]);
    setNotifications(notificationData.notifications);
    setQuietHours(quietData.quietHours);
    setSchedules(scheduleData.schedules);
    setStats(statsData);
    setDeliveryLogs(deliveryLogData.deliveryLogs);
    setLoggedIn(true);
  }

  useEffect(() => {
    // Initial admin state is loaded from the backend.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll().catch(() => setLoggedIn(false));
  }, []);

  async function login(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) });
      await loadAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ログインできませんでした。");
    }
  }

  async function saveNotification(event: FormEvent) {
    event.preventDefault();
    const path = editingNotificationId ? `/api/admin/notifications/${editingNotificationId}` : "/api/admin/notifications";
    await api(path, {
      method: editingNotificationId ? "PUT" : "POST",
      body: JSON.stringify(notificationForm),
    });
    setNotificationForm(emptyNotification);
    setEditingNotificationId(null);
    await loadAll();
  }

  async function saveQuietHour(event: FormEvent) {
    event.preventDefault();
    const path = editingQuietId ? `/api/admin/quiet-hours/${editingQuietId}` : "/api/admin/quiet-hours";
    await api(path, {
      method: editingQuietId ? "PUT" : "POST",
      body: JSON.stringify(quietForm),
    });
    setQuietForm(emptyQuiet);
    setEditingQuietId(null);
    await loadAll();
  }

  async function generateSchedules() {
    const result = await api<{ generated: number; warnings: string[] }>("/api/admin/schedules", { method: "POST" });
    setMessage(`今日のお告げを${result.generated}件つくりました。${result.warnings.join(" ")}`);
    await loadAll();
  }

  async function updateSchedule(id: number, value: string) {
    await api(`/api/admin/schedules/${id}`, {
      method: "PUT",
      body: JSON.stringify({ scheduled_at: new Date(value).toISOString() }),
    });
    await loadAll();
  }

  async function remove(path: string, label: string) {
    if (!window.confirm(`${label}を削除します。よろしいですか？`)) return;
    await api(path, { method: "DELETE" });
    await loadAll();
  }

  async function sendNow(id: number) {
    const result = await api<{ delivered: number; failed: number; removed: number }>(`/api/admin/schedules/${id}/send`, {
      method: "POST",
    });
    setMessage(`今すぐ送りました。成功: ${result.delivered}件 / 失敗: ${result.failed}件 / 購読解除: ${result.removed}件`);
    await loadAll();
  }

  if (!loggedIn) {
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
          <button className="mt-4 w-full rounded-2xl bg-slate-950 px-4 py-3 font-bold text-white">ログイン</button>
          {message && <p className="mt-4 text-sm text-red-600">{message}</p>}
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-cyan-700">OTSUGE ADMIN</p>
          <h1 className="text-3xl font-bold">お告げ管理</h1>
        </div>
        <div className="flex gap-3">
          <button className="rounded-full bg-white px-4 py-2 font-bold shadow-sm" onClick={loadAll}>
            更新
          </button>
          <button className="rounded-full bg-slate-950 px-4 py-2 font-bold text-white" onClick={generateSchedules}>
            今日のお告げを生成
          </button>
        </div>
      </header>
      {message && <p className="rounded-2xl bg-cyan-50 p-4 text-sm text-cyan-900">{message}</p>}

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
            required
          />
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Field label="開始">
              <input
                className="input"
                type="time"
                value={notificationForm.start_time}
                onChange={(event) => setNotificationForm({ ...notificationForm, start_time: event.target.value })}
              />
            </Field>
            <Field label="終了">
              <input
                className="input"
                type="time"
                value={notificationForm.end_time}
                onChange={(event) => setNotificationForm({ ...notificationForm, end_time: event.target.value })}
              />
            </Field>
            <Field label="1日の回数">
              <input
                className="input"
                type="number"
                min="1"
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
          <button className="mt-5 rounded-2xl bg-slate-950 px-5 py-3 font-bold text-white">
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
                      className="rounded-full bg-slate-100 px-3 py-1 text-sm font-bold"
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
                      className="rounded-full bg-red-50 px-3 py-1 text-sm font-bold text-red-700"
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
              />
            </Field>
            <Field label="終了">
              <input
                className="input"
                type="time"
                value={quietForm.end_time}
                onChange={(event) => setQuietForm({ ...quietForm, end_time: event.target.value })}
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
          <button className="mt-5 rounded-2xl bg-slate-950 px-5 py-3 font-bold text-white">
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
                    className="text-sm font-bold"
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
                    className="text-sm font-bold text-red-700"
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
                    onBlur={(event) => updateSchedule(schedule.id, event.target.value)}
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    className="rounded-full bg-cyan-100 px-3 py-2 text-sm font-bold text-cyan-900"
                    onClick={() => sendNow(schedule.id)}
                  >
                    今すぐ送る
                  </button>
                  <button
                    className="rounded-full bg-red-50 px-3 py-2 text-sm font-bold text-red-700"
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
