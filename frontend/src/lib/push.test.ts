import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { readPushEnvironment, subscribePush } from "./push";
import { getPushCardState, PERMISSION_DENIED_MESSAGE, PERMISSION_DISMISSED_MESSAGE } from "./push-state";

// push.ts はブラウザのグローバル（navigator / window / Notification）を読む。必要な分だけ差し替えて検証する。
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

const GLOBALS = ["navigator", "window", "Notification"] as const;
const originals = GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

type Browser = {
  userAgent: string;
  maxTouchPoints?: number;
  /** ホーム画面から開いているか（display-mode: standalone）。 */
  standalone?: boolean;
  /** iOS Safari 独自の navigator.standalone。 */
  navigatorStandalone?: boolean;
  /** Push API（PushManager / Notification）があるか。 */
  push?: boolean;
  serviceWorker?: boolean;
  permission?: NotificationPermission;
  /** 許可ダイアログの結果。 */
  answer?: NotificationPermission;
  subscribed?: boolean;
};

function installBrowser(browser: Browser) {
  const calls = { requestPermission: 0, register: 0 };
  const registration = {
    pushManager: { getSubscription: async () => (browser.subscribed ? { endpoint: "https://push.example/1" } : null) },
  };
  const navigator: Record<string, unknown> = {
    userAgent: browser.userAgent,
    maxTouchPoints: browser.maxTouchPoints ?? 5,
  };
  if (browser.navigatorStandalone !== undefined) navigator.standalone = browser.navigatorStandalone;
  if (browser.serviceWorker ?? true) {
    navigator.serviceWorker = {
      getRegistration: async () => registration,
      register: async () => {
        calls.register += 1;
        throw new Error("register() must not be reached in these tests");
      },
    };
  }
  const window: Record<string, unknown> = {
    isSecureContext: true,
    matchMedia: (query: string) => ({ matches: query === "(display-mode: standalone)" && Boolean(browser.standalone) }),
  };
  const define = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("navigator", navigator);
  define("window", window);
  if (browser.push ?? true) {
    const Notification = {
      permission: browser.permission ?? "default",
      requestPermission: async () => {
        calls.requestPermission += 1;
        return browser.answer ?? "default";
      },
    };
    window.PushManager = class {};
    window.Notification = Notification;
    define("Notification", Notification);
  } else {
    delete (globalThis as Record<string, unknown>).Notification;
  }
  return calls;
}

test("iPhone Safari (not on the home screen) is read as needing install", async () => {
  // Safari のタブには Service Worker はあるが Push API がない。
  installBrowser({ userAgent: IPHONE_SAFARI, push: false, navigatorStandalone: false });
  const env = await readPushEnvironment();
  assert.deepEqual(env, { ios: true, standalone: false, secure: true, supported: false, permission: "default", subscribed: false });
  assert.equal(getPushCardState(env), "needs-install");
});

test("iPhone opened from the home screen is read as able to subscribe", async () => {
  installBrowser({ userAgent: IPHONE_SAFARI, standalone: true, navigatorStandalone: true });
  const env = await readPushEnvironment();
  assert.equal(env.ios, true);
  assert.equal(env.standalone, true);
  assert.equal(getPushCardState(env), "unsubscribed");

  // display-mode が効かなくても、navigator.standalone だけで判定できる。
  installBrowser({ userAgent: IPHONE_SAFARI, standalone: false, navigatorStandalone: true });
  assert.equal((await readPushEnvironment()).standalone, true);
});

test("a blocked permission and an existing subscription are read from the browser", async () => {
  installBrowser({ userAgent: ANDROID_CHROME, permission: "denied" });
  assert.equal(getPushCardState(await readPushEnvironment()), "blocked");

  installBrowser({ userAgent: ANDROID_CHROME, permission: "granted", subscribed: true });
  assert.equal(getPushCardState(await readPushEnvironment()), "subscribed");

  installBrowser({ userAgent: ANDROID_CHROME, permission: "default" });
  assert.equal(getPushCardState(await readPushEnvironment()), "unsubscribed");
});

test("a browser without Service Worker is read as unsupported instead of throwing", async () => {
  installBrowser({ userAgent: ANDROID_CHROME, serviceWorker: false, push: false });
  const env = await readPushEnvironment();
  assert.equal(env.supported, false);
  assert.equal(env.subscribed, false);
  assert.equal(getPushCardState(env), "unsupported");
});

test("subscribePush() reports a block and a dismissed dialog differently, and stops there", async () => {
  const denied = installBrowser({ userAgent: ANDROID_CHROME, answer: "denied" });
  await assert.rejects(subscribePush(), { message: PERMISSION_DENIED_MESSAGE });
  assert.deepEqual(denied, { requestPermission: 1, register: 0 });

  const dismissed = installBrowser({ userAgent: ANDROID_CHROME, answer: "default" });
  await assert.rejects(subscribePush(), { message: PERMISSION_DISMISSED_MESSAGE });
  assert.deepEqual(dismissed, { requestPermission: 1, register: 0 });
});

test("subscribePush() names the supported environments when the APIs are missing", async () => {
  const calls = installBrowser({ userAgent: ANDROID_CHROME, push: false });
  await assert.rejects(subscribePush(), /iOS 16\.4 以上/);
  assert.equal(calls.requestPermission, 0);
});
