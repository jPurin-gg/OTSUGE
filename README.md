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

## 管理セッション

ログインごとにランダムなセッション ID を発行し、既存のDB（開発はSQLite、本番はPostgreSQL）に ID のハッシュ・有効期限・失効日時を保存します。有効期限はログインから7日間で、Cookieを手動で再送しても期限切れ・失効済みのセッションは管理APIで401になります。通常のログアウトは、そのセッションだけを失効させます。

全端末をログアウトさせる場合は、有効な管理Cookieを付けて `DELETE /api/admin/sessions` を呼び出してください。呼び出し元を含む全セッションを失効させ、呼び出し元のCookieも削除します。その後、新規ログインは可能です。`ADMIN_PASSWORD` または `AUTH_SECRET` の変更でも既存セッションを認証できなくなります。

セッションはDBに保存されるため、バックエンドの再起動後も期限・失効状態を維持します。複数のバックエンドを使う場合は、同じDBと認証設定を共有してください。期限切れレコードは次回ログイン時に削除します。

この方式への更新時に従来の管理Cookieはすべて無効になります。管理者は再ログインが必要です。既存DBには起動時にセッションテーブルを追加します。

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
