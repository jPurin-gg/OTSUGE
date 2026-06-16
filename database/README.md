# Database

ローカル開発ではSQLiteを使い、`database/data/otsuge.sqlite3` に保存します。

本番用ComposeではPostgreSQLサービスを起動し、`database.prod.env` の `DATABASE_URL` をbackendが参照します。
