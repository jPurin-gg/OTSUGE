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
