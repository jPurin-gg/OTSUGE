export type NotificationRecord = {
  id: number;
  message: string;
  start_time: string;
  end_time: string;
  count_per_day: number;
  min_interval_minutes: number;
  enabled: boolean | number;
  created_at: string;
  updated_at: string;
};

export type ScheduleRecord = {
  id: number;
  notification_id: number;
  scheduled_at: string;
  sent: boolean | number;
  discarded: boolean | number;
  delivery_status: "pending" | DeliveryStatus;
  delivery_deadline_at: string | null;
  manually_modified: boolean | number;
  created_at: string;
  updated_at: string;
};

export type QuietHoursRecord = {
  id: number;
  start_time: string;
  end_time: string;
  enabled: boolean | number;
  created_at: string;
  updated_at: string;
};

export type DeliveryStatus = "retrying" | "sent" | "partial" | "failed" | "discarded";

export type ScheduleDeliveryRecord = {
  id: number;
  schedule_id: number;
  subscription_id: number;
  status: "pending" | "retrying" | "sent" | "failed" | "removed" | "discarded";
  attempt_count: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DeliveryLogRecord = {
  id: number;
  schedule_id: number | null;
  status: DeliveryStatus;
  message: string;
  scheduled_at: string;
  sent_at: string;
  delivered_count: number;
  failed_count: number;
  pending_count: number;
  removed_subscription_count: number;
  created_at: string;
};
