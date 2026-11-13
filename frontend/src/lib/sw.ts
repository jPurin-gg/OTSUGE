const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "";

/**
 * 登録する Service Worker の URL。ビルド識別子をクエリに入れる。
 * 識別子が変わると URL が変わるので、ブラウザは新しい Service Worker として入れ直し、
 * sw.js 側はこの値をキャッシュ名に使って古いビルドのキャッシュを消す。
 * 識別子がない（開発サーバー）ときは `/sw.js` のままで、sw.js は JS・CSS をキャッシュしない。
 */
export function serviceWorkerUrl(buildId: string = BUILD_ID) {
  return buildId ? `/sw.js?v=${encodeURIComponent(buildId)}` : "/sw.js";
}

/** ページ表示時と通知の購読時の両方から呼ぶ。URL を揃えないと、片方がもう片方の登録を置き換えてしまう。 */
export function registerServiceWorker() {
  return navigator.serviceWorker.register(serviceWorkerUrl());
}
