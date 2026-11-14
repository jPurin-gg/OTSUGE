import assert from "node:assert/strict";
import { test } from "node:test";
import { loadAdminData } from "./admin-load";

const responses: Record<string, unknown> = {
  "/api/admin/stats": { subscriptionCount: 3 },
  "/api/admin/notifications": { notifications: [{ id: 1 }] },
  "/api/admin/quiet-hours": { quietHours: [{ id: 2 }] },
  "/api/admin/schedules": { schedules: [{ id: 3 }] },
  "/api/admin/delivery-logs": { deliveryLogs: [{ id: 4 }] },
};

test("未ログインのときは、ログイン確認の1回だけ呼び、一覧取得の API は呼ばない", async () => {
  const calls: string[] = [];
  const fetchApi = async <T>(path: string): Promise<T> => {
    calls.push(path);
    throw new Error("認証が必要です。");
  };
  await assert.rejects(loadAdminData(fetchApi), /認証が必要です。/);
  assert.equal(calls.length, 1);
});

test("ログイン済みのときは、確認のあとで残りの一覧を取得してまとめて返す", async () => {
  const calls: string[] = [];
  const fetchApi = async <T>(path: string): Promise<T> => {
    calls.push(path);
    return responses[path] as T;
  };
  const data = await loadAdminData(fetchApi);
  assert.deepEqual([...calls].sort(), Object.keys(responses).sort());
  assert.deepEqual(data.stats, { subscriptionCount: 3 });
  assert.deepEqual(data.notifications, [{ id: 1 }]);
  assert.deepEqual(data.quietHours, [{ id: 2 }]);
  assert.deepEqual(data.schedules, [{ id: 3 }]);
  assert.deepEqual(data.deliveryLogs, [{ id: 4 }]);
});

test("ログイン確認が終わるまで、一覧取得の API を呼び始めない", async () => {
  const calls: string[] = [];
  let confirm = () => {};
  const fetchApi = <T>(path: string): Promise<T> => {
    calls.push(path);
    if (calls.length > 1) return Promise.resolve(responses[path] as T);
    return new Promise<T>((resolve) => {
      confirm = () => resolve(responses[path] as T);
    });
  };
  const loading = loadAdminData(fetchApi);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  confirm();
  await loading;
  assert.equal(calls.length, 5);
});
