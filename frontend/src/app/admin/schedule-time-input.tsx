"use client";

import { useState } from "react";
import { isScheduleLocked, toTimeInputValue, type ScheduleTimeTarget } from "@/lib/schedule-time";

/**
 * 配信予定の時刻欄。時刻だけを編集する（日付は元の予定のまま）。
 * フォーカスを外したときに、値が変わっていれば onCommit を呼ぶ。onCommit が false を返したら元の時刻に戻す。
 * 送信済み・破棄済みの予定は編集できない。
 *
 * 予定の時刻が変わったら作り直すこと（key に scheduled_at を渡す）。
 */
export function ScheduleTimeInput({
  schedule,
  onCommit,
}: {
  schedule: ScheduleTimeTarget;
  onCommit: (value: string) => Promise<boolean>;
}) {
  const original = toTimeInputValue(schedule.scheduled_at);
  const [value, setValue] = useState(original);
  const [saving, setSaving] = useState(false);
  const locked = isScheduleLocked(schedule);

  async function commit() {
    if (locked || saving || value === original) return;
    setSaving(true);
    try {
      if (!(await onCommit(value))) setValue(original);
    } finally {
      setSaving(false);
    }
  }

  return (
    <input
      className="mt-2 rounded-xl border border-slate-200 px-3 py-2 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
      type="time"
      aria-label="配信時刻"
      title={locked ? "送信済み・破棄済みの予定は時刻を変更できません。" : undefined}
      value={value}
      required
      disabled={locked || saving}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}
