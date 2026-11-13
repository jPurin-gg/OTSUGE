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

example には秘密値を除くローカル用の値を設定済みです。`backend/backend.env` の `ADMIN_PASSWORD` と `AUTH_SECRET` に自分で決めた秘密値（`AUTH_SECRET` は十分に長いランダムな値）を設定し、`CRON_SECRET` は backend と scheduler の両方に同じ秘密値を設定してから起動します。Web Push を送る場合は、後述の VAPID 鍵も設定してください。

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
`POSTGRES_PASSWORD` と、そのパスワードを URL エンコードして含めた `DATABASE_URL`（`postgres://otsuge:<パスワード>@db:5432/otsuge`）を設定してください。example の `FRONTEND_ORIGIN` は本番の公開オリジンに、`VAPID_SUBJECT` は実際の連絡先に置き換えます。管理者認証・Cron・VAPID の秘密値も本番用に設定してください。
管理画面の本番パスワードは `backend/backend.prod.env` の `ADMIN_PASSWORD` です。

## 環境変数ファイル

`.env` / `.prod.env` 相当の実値入りファイルはGit管理しません。Gitには `*.env.example` / `*.prod.env.example` だけを含めます。

| 変数 | ローカル用の値・未設定時の扱い |
| --- | --- |
| `BACKEND_URL` | `http://backend:3001`。未設定・空文字ならこの値を使います。Docker 外で frontend を起動する場合は `http://localhost:3001` に変更します。 |
| `APP_TIMEZONE` | `Asia/Tokyo`。未設定・空文字ならこの値を使います。 |
| `FRONTEND_ORIGIN` | `http://localhost:3000`。未設定・空文字ならこの値を使います。複数指定はカンマ区切りです。 |
| `DB_CLIENT` | ローカルは `sqlite`、本番は `postgres`。未設定・空文字なら `sqlite` を使います。それ以外の値はエラーです。 |
| `SQLITE_PATH` | SQLite 使用時は必須です。example は `/data/otsuge.sqlite3`（ホスト側は `database/data/otsuge.sqlite3`）です。Docker 外では書き込み可能な保存先を指定してください。 |
| `DATABASE_URL` | PostgreSQL 使用時は必須です。秘密値を含むため example は空欄です。 |
| `NEXT_PUBLIC_API_BASE_URL` | 意図的に空欄です。同一オリジンの `/api` にアクセスし、frontend が backend へ中継します。 |
| `TZ` / `BACKEND_INTERNAL_URL` | scheduler 用の値は `Asia/Tokyo` / `http://backend:3001` です。 |

`SQLITE_PATH` / `DATABASE_URL` は選択した DB に応じて初回アクセス時（Compose ではヘルスチェック時）に検証し、未設定・空文字なら不足する変数名を含むエラーにします。一時 DB や別の DB へ自動で切り替えません。`CRON_SECRET` が未設定・空文字の場合も内部 API の初回アクセス時に変数名を含むエラーにします。これらの診断に設定値は含めません。ビルド・モジュール読込時に DB 接続設定は不要です。管理者認証の `ADMIN_PASSWORD` / `AUTH_SECRET` も必須です。

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
