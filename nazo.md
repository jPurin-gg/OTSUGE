# nazo.md

実装に必要だが仕様書だけでは確定できなかった事項です。

- 本番公開URLが未定のため、`backend/backend.prod.env` の `FRONTEND_ORIGIN` はローカル検証用の `http://localhost:3000` にしています。VPS/Cloudflareで公開する際は実際のHTTPS URLに変更してください。
- Web Push用VAPID鍵、管理者パスワード、Cookie署名用 `AUTH_SECRET`、Cron用 `CRON_SECRET`、PostgreSQLパスワードは生成済みです。
- `VAPID_SUBJECT` は連絡先が未指定のため `mailto:admin@example.com` のままです。運用者のメールアドレスまたはサイトURLへ変更してください。
- 通知禁止時間帯は複数登録できる実装にしています。仕様例は1件ですが、複数件を禁止したい場合にも対応できるためです。
- 管理者が当日スケジュールを手動編集した場合、仕様通り最低通知間隔と禁止時間帯の検証は行っていません。
- ローカルはSQLite、本番はPostgreSQLとして切り替えています。仕様書では本番DBのバックアップ・マイグレーション運用までは未指定です。
