import assert from "node:assert/strict";
import test from "node:test";
import {
  describePermissionRefusal,
  describePushError,
  getPushCardState,
  getPushCardView,
  isIos,
  NETWORK_FAILURE_MESSAGE,
  PERMISSION_DENIED_MESSAGE,
  PERMISSION_DISMISSED_MESSAGE,
  type PushEnvironment,
  UNKNOWN_FAILURE_MESSAGE,
} from "./push-state";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const WINDOWS_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Android / PC の対応ブラウザで、まだ何もしていない状態。 */
const READY: PushEnvironment = {
  ios: false,
  standalone: false,
  secure: true,
  supported: true,
  permission: "default",
  subscribed: false,
};

/** iPhone の Safari のタブ。Push API がない。 */
const IOS_SAFARI_TAB: PushEnvironment = { ...READY, ios: true, supported: false };
/** ホーム画面に追加した iPhone のアプリ（iOS 16.4 以上）。 */
const IOS_HOME_SCREEN: PushEnvironment = { ...READY, ios: true, standalone: true };

const UNSUPPORTED_BROWSER_TEXT = "このブラウザでは通知を使えません";

function allText(env: PushEnvironment | null) {
  const view = getPushCardView(env);
  return [view.heading, view.description, ...view.steps, view.note].join("\n");
}

test("isIos() recognises iPhone, iPad (including the desktop-class UA) and nothing else", () => {
  assert.equal(isIos({ userAgent: IPHONE_SAFARI, maxTouchPoints: 5 }), true);
  assert.equal(isIos({ userAgent: IPHONE_SAFARI.replace("iPhone;", "iPad;"), maxTouchPoints: 5 }), true);
  // iPadOS の Safari は Mac の UA を名乗る。タッチ点数で見分ける。
  assert.equal(isIos({ userAgent: IPAD_SAFARI, maxTouchPoints: 5 }), true);
  assert.equal(isIos({ userAgent: IPAD_SAFARI, maxTouchPoints: 0 }), false);
  assert.equal(isIos({ userAgent: ANDROID_CHROME, maxTouchPoints: 5 }), false);
  assert.equal(isIos({ userAgent: WINDOWS_CHROME, maxTouchPoints: 10 }), false);
});

test("the state is 'checking' until the environment has been read", () => {
  assert.equal(getPushCardState(null), "checking");
  assert.equal(getPushCardView(null).state, "checking");
});

test("iOS outside the home screen app needs installing, whatever else is true", () => {
  assert.equal(getPushCardState(IOS_SAFARI_TAB), "needs-install");
  // Push API が見えていても、ブロック済み・購読ありでも、iOS のタブでは追加の案内を優先する。
  assert.equal(getPushCardState({ ...IOS_SAFARI_TAB, supported: true }), "needs-install");
  assert.equal(getPushCardState({ ...IOS_SAFARI_TAB, supported: true, permission: "denied" }), "needs-install");
  assert.equal(getPushCardState({ ...IOS_SAFARI_TAB, supported: true, subscribed: true }), "needs-install");
});

test("iOS opened from the home screen can subscribe as before", () => {
  assert.equal(getPushCardState(IOS_HOME_SCREEN), "unsubscribed");
  assert.equal(getPushCardState({ ...IOS_HOME_SCREEN, permission: "granted", subscribed: true }), "subscribed");
});

test("missing APIs mean 'unsupported', except on iOS outside the home screen app", () => {
  assert.equal(getPushCardState({ ...READY, supported: false }), "unsupported");
  // ホーム画面から開いても API がない iOS（16.4 未満）は非対応。
  assert.equal(getPushCardState({ ...IOS_HOME_SCREEN, supported: false }), "unsupported");
});

test("a denied permission is 'blocked'; a dismissed dialog (default) stays 'unsubscribed'", () => {
  assert.equal(getPushCardState({ ...READY, permission: "denied" }), "blocked");
  assert.equal(getPushCardState({ ...IOS_HOME_SCREEN, permission: "denied" }), "blocked");
  assert.equal(getPushCardState({ ...READY, permission: "default" }), "unsubscribed");
  // 購読が残っていても、ブロック中は通知を出せないのでブロック中として扱う。
  assert.equal(getPushCardState({ ...READY, permission: "denied", subscribed: true }), "blocked");
});

test("a supported browser is 'subscribed' or 'unsubscribed' by its subscription", () => {
  assert.equal(getPushCardState(READY), "unsubscribed");
  assert.equal(getPushCardState({ ...READY, permission: "granted" }), "unsubscribed");
  assert.equal(getPushCardState({ ...READY, permission: "granted", subscribed: true }), "subscribed");
  assert.equal(getPushCardState({ ...READY, standalone: true, permission: "granted", subscribed: true }), "subscribed");
});

test("iPhone Safari gets the add-to-home-screen steps, not the unsupported-browser message", () => {
  const view = getPushCardView(IOS_SAFARI_TAB);
  assert.equal(view.state, "needs-install");
  assert.equal(view.steps.length, 3);
  assert.match(view.steps[0], /共有ボタン/);
  assert.match(view.steps[1], /「ホーム画面に追加」/);
  assert.match(view.steps[2], /ホーム画面.*アイコンから開/);
  assert.match(allText(IOS_SAFARI_TAB), /iOS 16\.4 以上/);
  assert.doesNotMatch(allText(IOS_SAFARI_TAB), new RegExp(UNSUPPORTED_BROWSER_TEXT));
  assert.doesNotMatch(allText(IOS_SAFARI_TAB), /非対応/);
});

test("the blocked view says it is blocked and how to unblock, per platform", () => {
  const ios = getPushCardView({ ...IOS_HOME_SCREEN, permission: "denied" });
  assert.match(ios.heading, /ブロック/);
  assert.match(ios.steps.join("\n"), /「設定」アプリ/);
  assert.match(ios.steps.join("\n"), /「通知を許可」/);

  const other = getPushCardView({ ...READY, permission: "denied" });
  assert.match(other.heading, /ブロック/);
  assert.match(other.steps.join("\n"), /サイトの設定/);
  assert.match(other.steps.join("\n"), /「通知」を「許可」/);
  assert.doesNotMatch(other.steps.join("\n"), /「設定」アプリ/);
});

test("the unsupported view tells which environments are supported", () => {
  const browser = allText({ ...READY, supported: false });
  assert.match(browser, /iOS 16\.4 以上/);
  assert.match(browser, /Chrome/);

  // ホーム画面から開いているのに使えない iOS には、OS の更新を案内する。
  const oldIos = allText({ ...IOS_HOME_SCREEN, supported: false });
  assert.match(oldIos, /iOS 16\.4 以上/);
  assert.match(oldIos, /更新/);

  // http で開いていると Service Worker が使えない。OS やブラウザのせいにしない。
  const insecure = allText({ ...READY, secure: false, supported: false });
  assert.match(insecure, /HTTPS/);
  assert.doesNotMatch(insecure, /iOS 16\.4/);
});

test("only the subscribable states keep the original wording and have no steps", () => {
  const unsubscribed = getPushCardView(READY);
  assert.equal(unsubscribed.heading, "未設定");
  assert.deepEqual(unsubscribed.steps, []);
  const subscribed = getPushCardView({ ...READY, permission: "granted", subscribed: true });
  assert.equal(subscribed.heading, "受け取り中");
  assert.deepEqual(subscribed.steps, []);
});

test("describePermissionRefusal() tells a block from a dismissed dialog", () => {
  assert.equal(describePermissionRefusal("granted"), null);
  assert.equal(describePermissionRefusal("denied"), PERMISSION_DENIED_MESSAGE);
  assert.equal(describePermissionRefusal("default"), PERMISSION_DISMISSED_MESSAGE);
  assert.notEqual(PERMISSION_DENIED_MESSAGE, PERMISSION_DISMISSED_MESSAGE);
  assert.match(PERMISSION_DENIED_MESSAGE, /ブロック/);
  assert.match(PERMISSION_DISMISSED_MESSAGE, /もう一度/);
});

const JAPANESE = /[぀-ヿ一-龯]/;
const ASCII_WORD = /[A-Za-z]{4,}/;

test("describePushError() never shows the browser's English message", () => {
  const browserErrors: unknown[] = [
    // Chrome: push サービスに登録できなかった。
    new DOMException("Registration failed - push service error", "AbortError"),
    new DOMException("Registration failed - permission denied", "NotAllowedError"),
    // Safari: Service Worker が有効になる前に購読しようとした。
    new DOMException("Subscribing for push requires an active service worker", "InvalidStateError"),
    new DOMException("A subscription with a different applicationServerKey already exists", "InvalidStateError"),
    new DOMException("The provided applicationServerKey is not valid.", "InvalidAccessError"),
    new DOMException("The string to be decoded is not correctly encoded.", "InvalidCharacterError"),
    new DOMException("Push is not supported", "NotSupportedError"),
    new DOMException("A network error occurred.", "NetworkError"),
    new DOMException("Something new", "SomeFutureError"),
    new TypeError("Failed to fetch"),
    new TypeError("Load failed"),
    new SyntaxError("Unexpected token < in JSON at position 0"),
    new Error(""),
    "Registration failed",
    undefined,
  ];
  for (const error of browserErrors) {
    const text = describePushError(error);
    assert.match(text, JAPANESE, `no Japanese text for ${String(error)}`);
    assert.doesNotMatch(text, ASCII_WORD, `English leaked for ${String(error)}: ${text}`);
  }
});

test("describePushError() maps the known failures to their own wording", () => {
  assert.match(describePushError(new DOMException("Registration failed - push service error", "AbortError")), /通知サービスに接続できません/);
  assert.match(describePushError(new DOMException("permission denied", "NotAllowedError")), /許可されていない/);
  assert.match(describePushError(new DOMException("no active service worker", "InvalidStateError")), /少し待ってから/);
  assert.match(describePushError(new DOMException("bad key", "InvalidAccessError")), /鍵/);
  assert.equal(describePushError(new TypeError("Failed to fetch")), NETWORK_FAILURE_MESSAGE);
  assert.equal(describePushError(new DOMException("Something new", "SomeFutureError")), UNKNOWN_FAILURE_MESSAGE);
  assert.equal(describePushError(null), UNKNOWN_FAILURE_MESSAGE);
});

test("describePushError() keeps the messages the app itself prepared", () => {
  // api() がサーバーの応答から作る Error や、push.ts が投げる Error。
  assert.equal(describePushError(new Error("通知用の鍵がまだ設定されていません。")), "通知用の鍵がまだ設定されていません。");
  assert.equal(describePushError(new Error(PERMISSION_DISMISSED_MESSAGE)), PERMISSION_DISMISSED_MESSAGE);
  // Error を継承したアプリ独自の例外（#14 の ApiError など）も同じ。
  class ApiError extends Error {
    readonly status = 400;
    constructor(message: string) {
      super(message);
      this.name = "ApiError";
    }
  }
  assert.equal(describePushError(new ApiError("入力内容が不正です。")), "入力内容が不正です。");
});
