# Database

ローカル開発ではSQLiteを使い、`database/data/otsuge.sqlite3` に保存します。

本番用ComposeではPostgreSQLサービスを起動し、`database.prod.env` の `DATABASE_URL` をbackendが参照します。

## Push配信結果と再試行

起動時の `readyDb()` が既存DBにも列・テーブルを追加します。既存の送信済み・破棄済み予定は、それぞれ `delivery_status = sent / discarded` として引き継ぎ、再送しません。

- `schedule_deliveries` は予定×購読で一意です。`status`、`attempt_count`、`last_error`、`next_attempt_at` を保存します。購読IDは失効購読の削除後も残し、endpoint・鍵・Pushエラーの本文は保存しません。予定削除時には配信状態も削除されます。
- 初回処理時に購読一覧と期限を確定します。再試行中の新規購読を追加せず、成功・恒久失敗・失効・破棄の購読には再送しません。送信途中の予定は当日スケジュール再生成でも保持します。
- 404/410では購読を削除して結果を `removed` とします。408/429/5xxと通信障害は1分、2分、4分、以後8分間隔で再試行し、その他のHTTPエラーは `failed` とします。
- 期限は予定時刻から30分です。未来の予定を即時送信した場合は送信開始から30分とし、後の予定時刻変更では延長しません。期限到達時は再送せず、未完了の購読を `discarded` とします。Pushサービスに渡すTTLも残り期限以内にし、1回の通信タイムアウトは10秒です。
- `last_error` はHTTPステータスまたは通信エラー種別のみです。復旧後も直近のエラーを残します。`attempt_count` は実際のPush呼び出しの試行数です。

予定の `sent` は処理完了を示します。成否は `delivery_status` で区別してください。

| 状態 | 意味 |
| --- | --- |
| `pending` | 配信開始前 |
| `retrying` | 未完了の購読があり、再試行待ち |
| `sent` | 全対象購読が成功（購読0件も含む） |
| `partial` | 成功と最終的な失敗・失効・破棄が混在 |
| `failed` | 成功なしで失敗・失効が確定 |
| `discarded` | 全対象が期限切れ（未開始の期限切れも含む） |

管理APIの `/api/admin/schedules` は `delivery_status` と `delivery_deadline_at` を返します。認証済みの `GET /api/admin/schedules/:id/deliveries` では予定全体の状態・期限と購読別の全記録を取得できます。`/api/admin/delivery-logs` の `status` も同じ状態を返し、各ログの件数はその処理時点の累計購読数です。`delivered_count` は成功、`failed_count` は確定した失敗・失効・破棄、`pending_count` は再試行待ちを表します。

管理画面の状態別ラベルの描画は別issue（#21）の対象です。並行dispatchのlease・排他制御（#3）には依存しません。本変更は直列処理での再送防止を行うため、#3との統合時には予定または購読のclaimと個別結果保存の整合を確認してください。
