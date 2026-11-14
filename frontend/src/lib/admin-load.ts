import { api } from "./api";

export type NotificationItem = {
  id: number;
  message: string;
  start_time: string;
  end_time: string;
  count_per_day: number;
  min_interval_minutes: number;
  enabled: boolean | number;
};

export type QuietHour = {
  id: number;
  start_time: string;
  end_time: string;
  enabled: boolean | number;
};

export type Schedule = {
  id: number;
  notification_id: number;
  scheduled_at: string;
  sent: boolean | number;
  discarded: boolean | number;
  manually_modified: boolean | number;
  message: string;
};

export type Stats = {
  subscriptionCount: number;
};

export type DeliveryLog = {
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

export type AdminData = {
  notifications: NotificationItem[];
  quietHours: QuietHour[];
  schedules: Schedule[];
  stats: Stats;
  deliveryLogs: DeliveryLog[];
};

type FetchApi = <T>(path: string) => Promise<T>;

/**
 * 管理画面の表示に使うデータをまとめて読み込む。
 *
 * まず軽い API を1つだけ呼んでログイン済みかを確かめ、通ってから残りの一覧を取得する。
 * 未ログインのときに、失敗すると分かっている一覧取得を並べて呼ばないため。
 */
export async function loadAdminData(fetchApi: FetchApi = api): Promise<AdminData> {
  const stats = await fetchApi<Stats>("/api/admin/stats");
  const [notificationData, quietData, scheduleData, deliveryLogData] = await Promise.all([
    fetchApi<{ notifications: NotificationItem[] }>("/api/admin/notifications"),
    fetchApi<{ quietHours: QuietHour[] }>("/api/admin/quiet-hours"),
    fetchApi<{ schedules: Schedule[] }>("/api/admin/schedules"),
    fetchApi<{ deliveryLogs: DeliveryLog[] }>("/api/admin/delivery-logs"),
  ]);
  return {
    notifications: notificationData.notifications,
    quietHours: quietData.quietHours,
    schedules: scheduleData.schedules,
    stats,
    deliveryLogs: deliveryLogData.deliveryLogs,
  };
}
