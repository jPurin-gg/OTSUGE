"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { api, formatTime, toDatetimeLocal } from "@/lib/api";
import {
  END_TIME_HINT,
  QUIET_HOURS_HINT,
  type TodayStatus,
  allDayQuietHoursConfirmText,
  isAllDayQuietHours,
  notificationTimeError,
  redrawConfirmText,
  redrawRemovableCount,
  redrawResultText,
  saveNotice,
  todayStatus,
} from "@/lib/notification-settings";

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

// お告げのフォームの下に出す案内。redrawId があれば「今日の分を引き直す」ボタンを添える。
type FormNotice = {
  tone: "info" | "error";
  text: string;
  redrawId: number | null;
};

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
  const [notificationNotice, setNotificationNotice] = useState<FormNotice | null>(null);
  const notificationFormRef = useRef<HTMLFormElement>(null);
  const quietFormRef = useRef<HTMLFormElement>(null);

  // 開始が終了より後だと1件も生成されないので、入力欄の下に理由を出して保存を止める。
  const notificationTimeProblem = notificationTimeError(notificationForm);
  // 無効なお告げの未送信の予定は送られない（backend が送信時に確認する）。
  // 有効に戻せば送られるので、予定の行は残して「送りません」と出す。
  const disabledNotificationIds = new Set(
    notifications.filter((item) => !Boolean(item.enabled)).map((item) => item.id),
  );
  const isBlocked = (schedule: Schedule) =>
    !Boolean(schedule.sent) && disabledNotificationIds.has(schedule.notification_id);
  const noticeRedrawTarget = notifications.find((item) => item.id === notificationNotice?.redrawId);

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
    if (notificationTimeProblem) return;
    const before = notifications.find((item) => item.id === editingNotificationId) ?? null;
    const path = editingNotificationId ? `/api/admin/notifications/${editingNotificationId}` : "/api/admin/notifications";
    try {
      const saved = await api<{ id?: number }>(path, {
        method: editingNotificationId ? "PUT" : "POST",
        body: JSON.stringify(notificationForm),
      });
      // 保存した設定が今日の予定にどう効くかを伝え、必要ならこのお告げだけの引き直しを勧める。
      const id = editingNotificationId ?? saved.id ?? null;
      const pendingToday = schedules.filter(
        (schedule) => schedule.notification_id === id && !Boolean(schedule.sent),
      ).length;
      const notice = saveNotice(before, notificationForm, pendingToday);
      setNotificationNotice({ tone: "info", text: notice.text, redrawId: notice.offerRedraw ? id : null });
    } catch (error) {
      setNotificationNotice({
        tone: "error",
        text: `保存できませんでした。${error instanceof Error ? error.message : ""}`,
        redrawId: null,
      });
      return;
    }
    setNotificationForm(emptyNotification);
    setEditingNotificationId(null);
    await loadAll();
  }

  function editNotification(item: NotificationItem) {
    setEditingNotificationId(item.id);
    setNotificationForm({
      message: item.message,
      start_time: item.start_time,
      end_time: item.end_time,
      count_per_day: item.count_per_day,
      min_interval_minutes: item.min_interval_minutes,
      enabled: Boolean(item.enabled),
    });
    setNotificationNotice(null);
    // スマホではフォームが一覧より上にあるので、編集中になったフォームまで戻す。
    notificationFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function cancelNotificationEdit() {
    setNotificationForm(emptyNotification);
    setEditingNotificationId(null);
    setNotificationNotice(null);
  }

  // このお告げだけ、今日の予定を現在の設定で引き直す。未送信の予定が削除されるときは件数を確認する。
  async function redrawNotification(item: NotificationItem) {
    if (redrawRemovableCount(item, schedules) > 0 && !window.confirm(redrawConfirmText(item, schedules))) return;
    try {
      const result = await api<{ generated: number; removed: number; warnings: string[] }>(
        `/api/admin/notifications/${item.id}/schedules`,
        { method: "POST" },
      );
      const text = redrawResultText(item, result);
      setMessage(text);
      setNotificationNotice((current) => (current ? { tone: "info", text, redrawId: null } : null));
    } catch (error) {
      const text = `今日の予定を引き直せませんでした。${error instanceof Error ? error.message : ""}`;
      setMessage(text);
      setNotificationNotice((current) => (current ? { ...current, tone: "error", text } : null));
    }
    await loadAll();
  }

  async function saveQuietHour(event: FormEvent) {
    event.preventDefault();
    // 開始と終了が同じだと終日が禁止時間帯になり、全お告げが生成されなくなるので、確認してから保存する。
    if (isAllDayQuietHours(quietForm) && !window.confirm(allDayQuietHoursConfirmText(quietForm))) return;
    const path = editingQuietId ? `/api/admin/quiet-hours/${editingQuietId}` : "/api/admin/quiet-hours";
    await api(path, {
      method: editingQuietId ? "PUT" : "POST",
      body: JSON.stringify(quietForm),
    });
    setQuietForm(emptyQuiet);
    setEditingQuietId(null);
    await loadAll();
  }

  function editQuietHour(quiet: QuietHour) {
    setEditingQuietId(quiet.id);
    setQuietForm({
      start_time: quiet.start_time,
      end_time: quiet.end_time,
      enabled: Boolean(quiet.enabled),
    });
    quietFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function cancelQuietEdit() {
    setQuietForm(emptyQuiet);
    setEditingQuietId(null);
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
        <StatCard
          label="今日の未送信"
          value={`${schedules.filter((schedule) => !Boolean(schedule.sent) && !isBlocked(schedule)).length}件`}
        />
        <StatCard label="最近のログ" value={`${deliveryLogs.length}件`} />
      </section>

      <section className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <form
          ref={notificationFormRef}
          className={`scroll-mt-4 rounded-3xl bg-white p-6 shadow-sm ${editingNotificationId ? "ring-2 ring-cyan-400" : ""}`}
          onSubmit={saveNotification}
        >
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
            <Field label="終了" hint={END_TIME_HINT}>
              <input
                className="input"
                type="time"
                value={notificationForm.end_time}
                aria-invalid={Boolean(notificationTimeProblem)}
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
          {notificationTimeProblem && (
            <p role="alert" className="mt-3 text-sm font-bold text-red-700">
              {notificationTimeProblem}
            </p>
          )}
          <label className="mt-4 flex items-center gap-2 text-sm font-bold">
            <input
              type="checkbox"
              checked={Boolean(notificationForm.enabled)}
              onChange={(event) => setNotificationForm({ ...notificationForm, enabled: event.target.checked })}
            />
            有効
          </label>
          <p className="mt-1 text-xs text-slate-500">
            無効にすると、今日の未送信の予定も送りません。有効に戻すと、残っている予定は送られます。
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              className="rounded-2xl bg-slate-950 px-5 py-3 font-bold text-white disabled:opacity-40"
              disabled={Boolean(notificationTimeProblem)}
            >
              {editingNotificationId ? "更新" : "追加"}
            </button>
            {editingNotificationId && (
              <button
                type="button"
                className="rounded-2xl border border-slate-300 px-5 py-3 font-bold"
                onClick={cancelNotificationEdit}
              >
                キャンセル
              </button>
            )}
          </div>
          {notificationNotice && (
            <div
              role={notificationNotice.tone === "error" ? "alert" : "status"}
              className={`mt-4 rounded-2xl p-4 text-sm ${
                notificationNotice.tone === "error" ? "bg-red-50 text-red-800" : "bg-cyan-50 text-cyan-900"
              }`}
            >
              <p>{notificationNotice.text}</p>
              {noticeRedrawTarget && (
                <button
                  type="button"
                  className="mt-3 rounded-full bg-cyan-900 px-4 py-2 text-sm font-bold text-white"
                  onClick={() => redrawNotification(noticeRedrawTarget)}
                >
                  今日の分を引き直す
                </button>
              )}
            </div>
          )}
        </form>

        <section className="rounded-3xl bg-white p-6 shadow-sm">
          <h2 className="text-xl font-bold">お告げ一覧</h2>
          <div className="mt-4 divide-y divide-slate-100">
            {notifications.map((item) => (
              <div
                key={item.id}
                className={
                  editingNotificationId === item.id
                    ? "-mx-3 rounded-2xl bg-cyan-50 px-3 py-4 ring-2 ring-cyan-400"
                    : "py-4"
                }
                aria-current={editingNotificationId === item.id ? "true" : undefined}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-bold">
                      {item.message}
                      {editingNotificationId === item.id && <EditingBadge />}
                    </p>
                    <p className="text-sm text-slate-500">
                      {item.start_time}-{item.end_time} / {item.count_per_day}回 / {item.min_interval_minutes}分間隔 /{" "}
                      {Boolean(item.enabled) ? "有効" : "無効"}
                    </p>
                    {/* 自動生成で設定回数に満たなかったお告げが、画面を開けば分かるようにする。 */}
                    <TodayBadge status={todayStatus(item, schedules, quietHours)} />
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-2">
                    {Boolean(item.enabled) && (
                      <button
                        className="rounded-full bg-cyan-100 px-3 py-1 text-sm font-bold text-cyan-900"
                        onClick={() => redrawNotification(item)}
                      >
                        今日の分を引き直す
                      </button>
                    )}
                    <button
                      className="rounded-full bg-slate-100 px-3 py-1 text-sm font-bold"
                      onClick={() => editNotification(item)}
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
        <form
          ref={quietFormRef}
          className={`scroll-mt-4 rounded-3xl bg-white p-6 shadow-sm ${editingQuietId ? "ring-2 ring-cyan-400" : ""}`}
          onSubmit={saveQuietHour}
        >
          <h2 className="text-xl font-bold">{editingQuietId ? "静かにする時間を編集" : "静かにする時間"}</h2>
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
          <p className="mt-2 text-xs text-slate-500">{QUIET_HOURS_HINT}</p>
          {isAllDayQuietHours(quietForm) && (
            <p className="mt-2 text-sm font-bold text-amber-800">
              開始と終了が同じなので、終日が「静かにする時間」になります（有効な間は、お告げが生成されません）。
            </p>
          )}
          <label className="mt-4 flex items-center gap-2 text-sm font-bold">
            <input
              type="checkbox"
              checked={Boolean(quietForm.enabled)}
              onChange={(event) => setQuietForm({ ...quietForm, enabled: event.target.checked })}
            />
            有効
          </label>
          <div className="mt-5 flex flex-wrap gap-2">
            <button className="rounded-2xl bg-slate-950 px-5 py-3 font-bold text-white">
              {editingQuietId ? "更新" : "追加"}
            </button>
            {editingQuietId && (
              <button
                type="button"
                className="rounded-2xl border border-slate-300 px-5 py-3 font-bold"
                onClick={cancelQuietEdit}
              >
                キャンセル
              </button>
            )}
          </div>
          <div className="mt-4 space-y-2">
            {quietHours.map((quiet) => (
              <div
                key={quiet.id}
                className={`flex items-center justify-between rounded-2xl p-3 ${
                  editingQuietId === quiet.id ? "bg-cyan-50 ring-2 ring-cyan-400" : "bg-slate-50"
                }`}
                aria-current={editingQuietId === quiet.id ? "true" : undefined}
              >
                <span>
                  {quiet.start_time}-{quiet.end_time}
                  {isAllDayQuietHours(quiet) ? "（終日）" : ""} / {Boolean(quiet.enabled) ? "有効" : "無効"}
                  {editingQuietId === quiet.id && <EditingBadge />}
                </span>
                <span className="flex gap-2">
                  <button type="button" className="text-sm font-bold" onClick={() => editQuietHour(quiet)}>
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
                    {Boolean(schedule.sent)
                      ? Boolean(schedule.discarded)
                        ? "破棄"
                        : "送信済み"
                      : isBlocked(schedule)
                        ? "送りません（お告げが無効）"
                        : "未送信"}
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
                    className="rounded-full bg-cyan-100 px-3 py-2 text-sm font-bold text-cyan-900 disabled:opacity-40"
                    disabled={isBlocked(schedule)}
                    title={
                      isBlocked(schedule)
                        ? "お告げが無効のため送れません。送るには、お告げを有効にしてください。"
                        : undefined
                    }
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

function EditingBadge() {
  return <span className="ml-2 rounded-full bg-cyan-900 px-2 py-0.5 text-xs text-white">編集中</span>;
}

function TodayBadge({ status }: { status: TodayStatus }) {
  const color =
    status.tone === "warn"
      ? "bg-amber-100 text-amber-900"
      : status.tone === "muted"
        ? "bg-slate-100 text-slate-600"
        : "bg-emerald-50 text-emerald-700";
  return (
    <p className={`mt-1 w-fit rounded-full px-2 py-0.5 text-xs font-bold ${color}`}>
      {status.tone === "warn" ? "⚠ " : ""}
      {status.text}
    </p>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm font-bold">
      {label}
      <div className="mt-2 [&_.input]:w-full [&_.input]:rounded-2xl [&_.input]:border [&_.input]:border-slate-200 [&_.input]:px-4 [&_.input]:py-3">
        {children}
      </div>
      {hint && <span className="mt-1 block text-xs font-normal text-slate-500">{hint}</span>}
    </label>
  );
}
