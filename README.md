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

### 配信の期限と処理上限

自動配信は送信直前と各購読への送信前に期限を再確認し、予定から30分以上経過していれば未送信分を破棄します。破棄結果は、途中までの成功・失敗件数とともに送信ログへ保存します。

1回の定期処理では予定を最大20件、Push要求を合計200件まで扱います。購読はID順に5件ずつ取得し、最大5件を同時送信します。送信処理の時間枠は45秒、各Push要求は最大5秒で、自動配信の残存期限や処理時間の残りが短ければ要求時間も短縮します。web-pushのソケットタイムアウトに加えて全体タイマーを設け、超過時は接続を破棄します。DBアクセス・進捗保存の時間は45秒を超える場合があります。

件数・時間の上限に達した場合は、購読IDの進捗と累計件数をDBへ保存して次回の定期処理で継続します。配信開始後に追加された購読はその予定の対象に加えません。状態と最終ログはトランザクションで確定します。進捗は5件のバッチごとに保存するため、送信直後・進捗保存前のプロセス停止時には同じバッチが再送される可能性があります。同時実行の排他制御と一時失敗の再試行は別途扱います。

管理者の「今すぐ送る」は30分破棄を適用しません。要求時間・同時送信数・件数・処理時間の上限は共通で、継続が必要な場合も即時送信として保存し、次回の定期処理で30分破棄せずに送ります。管理APIはこの場合 `pending: true` を返します。

定期処理を呼ぶcurlは接続5秒・全体55秒で打ち切ります。curlの切断だけに依存せず、バックエンド側も上記の上限で処理します。
