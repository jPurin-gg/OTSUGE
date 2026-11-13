import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { getSubscriptionStatus } from "./push";

// getSubscriptionStatus() はブラウザの navigator を使う。Service Worker の有無を差し替えて検証する。

const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "navigator", original);
  else delete (globalThis as Record<string, unknown>).navigator;
});

function installNavigator(value: unknown) {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
}

function serviceWorkerWith(registration: unknown) {
  return { serviceWorker: { getRegistration: async () => registration } };
}

test("Service Worker が使えない環境（http など）では、例外にせず未購読として扱う", async () => {
  installNavigator({});
  assert.equal(await getSubscriptionStatus(), false);
});

test("navigator.serviceWorker が undefined でも未購読として扱う", async () => {
  installNavigator({ serviceWorker: undefined });
  assert.equal(await getSubscriptionStatus(), false);
});

test("Service Worker が未登録なら未購読", async () => {
  installNavigator(serviceWorkerWith(undefined));
  assert.equal(await getSubscriptionStatus(), false);
});

test("Push 非対応で pushManager がない登録でも、例外にせず未購読として扱う", async () => {
  installNavigator(serviceWorkerWith({}));
  assert.equal(await getSubscriptionStatus(), false);
});

test("購読がなければ未購読、あれば購読中", async () => {
  installNavigator(serviceWorkerWith({ pushManager: { getSubscription: async () => null } }));
  assert.equal(await getSubscriptionStatus(), false);

  installNavigator(
    serviceWorkerWith({ pushManager: { getSubscription: async () => ({ endpoint: "https://push.example/send/1" }) } }),
  );
  assert.equal(await getSubscriptionStatus(), true);
});

test("購読状態の確認そのものが失敗したときは例外を伝える（画面で失敗として表示する）", async () => {
  installNavigator({
    serviceWorker: {
      getRegistration: async () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    },
  });
  await assert.rejects(getSubscriptionStatus(), { name: "SecurityError" });
});
