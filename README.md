# OTSUGE

ランダムなタイミングで全購読者へWeb Push通知を送るPWAです。

## ローカル起動

ホスト側で `npm install` は不要です。依存関係のインストール、Next.js起動、SQLite利用、Cron実行はDocker内で行います。

初回だけenvファイルを作成してください。

```sh
cp frontend/frontend.env.example frontend/frontend.env
cp backend/backend.env.example backend/backend.env
cp database/database.env.example database/database.env
cp scheduler/scheduler.env.example scheduler/scheduler.env
```

各envファイルの右辺にローカル用の値を設定してから起動します。

```sh
docker compose up --build
```

- フロントエンド: http://localhost:3000
- 管理画面: http://localhost:3000/admin
- バックエンドAPI: http://localhost:3001（ブラウザからは `/api` 経由）

管理画面の初期パスワードは `backend/backend.env` の `ADMIN_PASSWORD` です。

## 本番想定起動

初回だけ本番用envファイルを作成してください。

```sh
cp frontend/frontend.prod.env.example frontend/frontend.prod.env
cp backend/backend.prod.env.example backend/backend.prod.env
cp database/database.prod.env.example database/database.prod.env
cp scheduler/scheduler.prod.env.example scheduler/scheduler.prod.env
```

各prod envファイルの右辺に本番用の値を設定してから起動します。

```sh
docker compose -f compose.prod.yaml up --build -d
```

本番では `database/database.prod.env` のPostgreSQL設定を使います。
管理画面の本番パスワードは `backend/backend.prod.env` の `ADMIN_PASSWORD` です。

## 環境変数ファイル

`.env` / `.prod.env` 相当の実値入りファイルはGit管理しません。Gitには `*.env.example` / `*.prod.env.example` だけを含めます。

ローカル用:

- `frontend/frontend.env`
- `backend/backend.env`
- `database/database.env`
- `scheduler/scheduler.env`

本番用:

- `frontend/frontend.prod.env`
- `backend/backend.prod.env`
- `database/database.prod.env`
- `scheduler/scheduler.prod.env`

## VAPID鍵

Web Pushを実際に送るにはVAPID鍵が必要です。backendコンテナ内で生成できます。

```sh
docker compose run --rm backend npx web-push generate-vapid-keys
```

本番用の鍵は `backend/backend.prod.env` に生成済みです。運用開始後にVAPID鍵を変更すると既存購読は再購読が必要になります。

## Cron

`scheduler` コンテナがbusybox `crond` を起動します。

- `* * * * *`: 送信対象の通知を処理
- `0 0 * * *`: 当日分スケジュールを生成

内部APIは `CRON_SECRET` のBearer認証で保護しています。

## Push 購読の接続先制限

購読登録時と配信時に endpoint と鍵を検証します。HTTPS・443 のみ許可し、接続先ホストは次のサービスに限定します。ユーザー情報、フラグメント、IP リテラル、非標準ポートは拒否します。パスとクエリはサービス発行の値を保持します（WNS はクエリにトークンを含みます）。

| 対応サービス | 許可ホスト | 一次資料 |
| --- | --- | --- |
| Chrome / Chromium 系（FCM） | `fcm.googleapis.com` | [Chromium の endpoint 定義](https://chromium.googlesource.com/chromium/src/%2B/refs/tags/141.0.7390.94/components/push_messaging/push_messaging_constants.cc) |
| Firefox（Mozilla Autopush） | `updates.push.services.mozilla.com` | [Mozilla HTTP API](https://mozilla-services.github.io/autopush-rs/http.html) |
| Safari / iOS・iPadOS のホーム画面 Web App | `*.push.apple.com` | [Apple Web Push](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers) |
| Windows Edge（WNS） | `*.notify.windows.com` | [Edge の WNS 利用](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/forcebuiltinpushmessagingclient)、[WNS の送信先一覧](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/firewall-allowlist-config) |

ワイルドカードはドット境界で照合し、ルートドメインや似た名前のホストには一致させません。ブラウザの独自 Push サーバー設定や上記以外のサービスは対象外です。サービスの endpoint が変更された場合は、公式資料を確認して許可リストとテストを更新してください。

endpoint は最大 2048 文字、購読登録・解除の JSON 本文は最大 4096 バイトです。本文はフロントエンドの中継前とバックエンドの両方で、実際に読み取ったバイト数を制限します。鍵は有効な非圧縮 P-256 公開鍵（65 バイト）と auth（16 バイト）の base64url 形式を検証します。不正な入力は 400、過大な本文は 413 を返します。

登録・解除はプロセスごとに全クライアント共有のトークンバケットで制限します（初期・最大 30 件、2 秒ごとに 1 件回復）。制限時は `Retry-After` 付きの 429 を返します。クライアントが偽装できる転送元 IP ヘッダーには依存しません。複数プロセスにまたがる制限や利用者ごとの公平性は保証しないため、公開運用時の追加制限は信頼できる入口で設定してください。

登録前に DNS の全アドレスを検証します。配信では `https.Agent` の `lookup` 内で再検証し、その検証済み IP を直接ソケットへ渡します。これにより登録後の DNS 変更にも対応し、事前検証と接続の間の再解決を防ぎます。ホスト名は維持するため、通常の TLS 証明書検証・SNI・VAPID audience を利用できます。プロキシとリダイレクト追従は使用しません。DNS は 5 秒、送信ソケットの無通信は 10 秒で打ち切ります。

IP は [IANA IPv4 特殊用途一覧](https://www.iana.org/assignments/iana-ipv4-special-registry/) と [IPv6 特殊用途一覧](https://www.iana.org/assignments/iana-ipv6-special-registry/) に基づき、loopback、私設、リンクローカル、共有、文書用、ベンチマーク、multicast、予約・移行用の範囲を拒否します。IPv6 は `2000::/3` 内の公開用アドレスに限定し、特殊用途範囲と旧 `3ffe::/16` も除外します。IPv4 埋め込み・NAT64 形式は許可しません。[Azure 内部プラットフォーム用 IP](https://learn.microsoft.com/en-us/azure/virtual-network/what-is-ip-address-168-63-129-16) `168.63.129.16` も拒否します。DNS 応答に一つでも不許可 IP が混在する場合は接続しません。
