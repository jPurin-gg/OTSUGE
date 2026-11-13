import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleTimeInput } from "../app/admin/schedule-time-input";

// 初期表示の HTML だけを確かめる（フォーカスを外したときの判定は schedule-time.test.ts）。
function render(overrides: { sent?: boolean | number; discarded?: boolean | number } = {}) {
  const schedule = {
    scheduled_at: new Date(2026, 10, 14, 9, 42).toISOString(),
    sent: false,
    discarded: false,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(ScheduleTimeInput, { schedule, onCommit: async () => true }));
}

test("時刻欄は日付を持たない time 入力で、予定の時刻を表示する", () => {
  const html = render();
  assert.match(html, /type="time"/);
  assert.match(html, /value="09:42"/);
  assert.doesNotMatch(html, /datetime-local/);
});

test("未送信の予定の時刻欄は編集できる", () => {
  assert.doesNotMatch(render(), /disabled=""/);
});

test("送信済みの予定の時刻欄は編集できない", () => {
  assert.match(render({ sent: true }), /disabled=""/);
  assert.match(render({ sent: 1 }), /disabled=""/);
});

test("破棄済みの予定の時刻欄は編集できない", () => {
  assert.match(render({ sent: true, discarded: true }), /disabled=""/);
  assert.match(render({ sent: 1, discarded: 1 }), /disabled=""/);
});
