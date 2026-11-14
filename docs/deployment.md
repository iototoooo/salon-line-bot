# デプロイ手順（Vercel）：美容室向け LINE bot＋AI自動応答システム

- 版数：v0.4（2026-11-12 作成。2026-11-13 に Vercel Hobby（無料）向けに定期実行を Cron Jobs から Schedules に変更。同日、保持期間の削除（1 日 1 回）、6〜8 章（Hobby の確認・環境変数・Webhook の切り替え・初回デプロイの順序）、9〜10 章（Vercel CLI での初回デプロイ手順・デプロイ後の安全確認）を追加。2026-11-14 に 11 章（定期実行の有効化）を追加）
- 関連資料：[architecture.md](./architecture.md)（5.4 環境変数・6.4／6.5 オーナー通知と定期実行）／[supabase-setup.md](./supabase-setup.md)／[wbs.md](./wbs.md)（5.1 本番環境構築）
- 本番環境の構築全体（WBS 5.1：Webhook URL の設定・LINE の切り替えなど）は、構築時にこの資料へ追記する。

> **本番へのデプロイ・環境変数の登録・LINE の実送信は、オーナー（クライアント）の承認後に行う。**
> この資料の手順は 2026-11-13 時点ではまだ実施していない。

---

## 1. 事前に確認すること

| 項目 | 確認内容 | 状態 |
|------|----------|------|
| Vercel のプラン | **学習課題のため Hobby（無料）で運用する**（2026-11-13 決定。Hobby は非商用・個人利用が条件で、本課題は非商用）。実際のクライアント案件として商用運用する場合は Pro（クライアント名義）が必要 | Hobby で進める方針 |
| Vercel の費用 | Hobby は無料。Schedules の実行は月 5,000 回まで（15 分ごと＋1 日 1 回で月 3,007 回以内）。超えるとその月の定期実行が止まる（Webhook 受信時の通知は続く） | 無料の範囲 |
| Supabase | 8 本のマイグレーションが適用済みであること（`supabase-setup.md`。8 本目 `20261115000000_retention_purge.sql` は 2026-11-13 に適用済み。未適用の環境で保持期間の削除を動かすと毎日 500 になる）。Free プランは 1 週間操作がないと一時停止するため、本番のプランを決める | プランは**未確認** |
| LINE | 通知先（`shop_settings.owner_line_user_id`）の設定と、オーナーの友だち追加。設定までは通知は送られない（対象は未通知のまま残る） | 未設定 |
| Next.js の設定 | `trailingSlash` を有効にしない（Cron はリダイレクトを追わないため、`/api/cron/owner-notify/` へのリダイレクトで実行されなくなる） | 無効（確認済み） |

## 2. 定期実行（Vercel Schedules）の設定内容

リポジトリの `vercel.json`（2026-11-13 変更。旧：Cron Jobs の 5 分ごと）：

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "schedules": {
    "owner-notify": {
      "schedule": "*/15 * * * *",
      "path": "/api/cron/owner-notify",
      "requestMethod": "GET"
    },
    "retention": {
      "schedule": "17 18 * * *",
      "path": "/api/cron/retention",
      "requestMethod": "GET"
    }
  }
}
```

- **15 分ごと**（UTC。1 日 96 回・月 2,976 回以内）。Hobby では最短 15 分で、実行時刻は 15 分の幅の中でずれる（`jitter` は指定しない。Hobby は常に 15 分）。
- 変更の理由（Vercel 公式ドキュメント、2026-11-13 確認）：Hobby の Cron Jobs は 1 日 1 回までで、5 分ごとの式は**デプロイが失敗する**。Schedules（ベータ）は Hobby で 15 分ごとまで・月 5,000 回まで使える。
- **Schedules はベータ**のため、仕様が変わる可能性がある。止まっても、通知は Webhook の受信時に送られ、停止イベントは次回の実行で検出される（処理は何度呼ばれても安全）。
- **本番の環境でだけ実行される**（Schedules は Preview にも設定できるが、本案件では本番だけで使う）。
- Vercel は `GET`（`requestMethod` で指定。既定は POST のため必ず指定する）で呼び、環境変数 `CRON_SECRET` があれば `Authorization: Bearer <CRON_SECRET>` を付ける（パスのターゲットの仕様）。
- **retention**（保持期間の削除）：毎日 18:17 UTC（日本時間 03:17。15 分の幅でずれる）。会話ログ 90 日・Webhook イベント 7 日・利用枠 2 日・通知記録 30 日を過ぎたものを削除する（DB 関数 `public.run_retention_purge`、8 本目。仕様は `architecture.md` 6.6）。オーナー通知の実行時刻（毎時 0・15・30・45 分）と重ならないよう 17 分にしている。
- ルートの最大実行時間はどちらも 60 秒（各 `route.ts` の `maxDuration`）。
- どちらのルートも **GET だけを公開**している。`requestMethod` を外すと既定の POST で呼ばれ、毎回 405 で失敗する。
- 失敗しても Vercel は再試行しない。実行漏れ・重複実行があっても、次の実行で未通知のものをまとめて扱う（重複送信は DB のロックと再送キーで防ぐ）。
- LINE への push の回数は Cron の間隔ではなく DB 側の制限で決まる（10 分間隔・1 日 5 通・利用上限の通知 1 日 1 回）。

## 3. CRON_SECRET の作成と登録

1. **値の作成**（32 文字以上・英数字のみ）。画面に表示せず、クリップボードにだけコピーする（PowerShell の実行履歴にはコマンドだけが残り、値は残らない）：

   ```powershell
   $b = New-Object byte[] 32
   [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
   -join ($b | ForEach-Object { $_.ToString('x2') }) | Set-Clipboard
   Remove-Variable b
   ```

   64 文字の 16 進数になる。貼り付け時に改行・前後の空白が入らないようにする（入ると毎回 401、または Vercel のビルドエラーになる）。

2. **原本の保管**：クライアントのパスワード管理ツールに保存する。チャット・メール・Git・`vercel.json`・`.env.example` には書かない。
   - **2026-11-14 変更**：11 章のスクリプト（`scripts/vercel/register-cron.ps1`）で作って登録し、原本は保存しない方針にした（運用で使わないため。作り直すときは再登録する）。
3. **Vercel への登録**：プロジェクトの Settings → Environment Variables で `CRON_SECRET` を追加する。
   - Environment は **Production のみ**（Preview・Development には設定しない。設定しない環境ではルートが常に 503 を返し、DB にも LINE にも接続しない）。
   - **Sensitive** にする（保存後は画面に再表示されない）。
4. 登録後に**デプロイする**まで反映されない（Vercel はデプロイ時点の値を使う）。

## 4. デプロイと確認

1. 本番へデプロイする（承認後）。
2. Vercel のプロジェクト → **Schedules** に `owner-notify`（`*/15 * * * *`・`/api/cron/owner-notify`）と `retention`（`17 18 * * *`・`/api/cron/retention`）が表示されることを確認する。「Run Schedule」で、待たずに 1 回実行できる（月 5,000 回の上限に数えられる）。
3. 実行履歴・ログで、15 分ごとの実行が `200` を返していることを確認する。応答の例（件数と結果コードのみ）：
   - `{"ok":true,"stalled":0,"notification":"dry_run"}`：`LINE_REPLY_MODE` が dry-run の間
   - `{"ok":true,"stalled":0,"notification":"no_recipient"}`：live だが通知先が未設定
   - `{"ok":true,"stalled":0,"notification":"nothing"}`：通知の対象なし
   - `500`（`"ok":false`）：停止イベントの検出の失敗（`"error":"stalled_check_failed"`）、または通知が `error`・`failed`・`unknown`（DB エラー・LINE の拒否・成否不明）。実行履歴で「失敗」として気づけるようにしている（2026-11-13 変更。以前は 200）。Vercel は再試行しないが、次の実行で未通知の分をまとめて扱い、成否不明は同じ再送キーで送り直す
4. 保持期間の削除：翌日以降、`retention` の実行履歴が `200` であることを確認する。応答は件数だけ（例：`{"ok":true,"result":"purged","deleted":{"conversations":0,"lineWebhookEvents":12,"aiUsageReservations":3,"ownerNotificationBatches":0}}`）。`{"ok":true,"result":"busy"}` は別の削除が実行中だったため何もしなかった（重複実行。問題なし）。`500` の `{"error":"purge_failed"}` は DB エラー（8 本目の未適用など）、`{"error":"not_configured"}` は Supabase の接続情報がない。どちらもログにはエラーコードだけが残る。
5. 認証の確認（任意）：`CRON_SECRET` なしで本番の `/api/cron/owner-notify` を開くと `401` になること。Preview のデプロイでは `503` になること。
6. すべての実行が `401` になる場合は、`CRON_SECRET` の値の改行・空白、Production に設定されているか、登録後に再デプロイしたかを確認する。

## 5. 運用

- **停止したいとき**：Vercel の **Schedules** で `owner-notify` を選び **Disable**（再デプロイ不要。再度有効にするまで止まる）。通知の対象は未通知のまま残り、Webhook の受信時には引き続き送られる。`retention` を止めると、期限切れのデータが残る（再開した最初の実行でまとめて削除される）。
- **削除件数・失敗の確認**：Vercel の Schedules の実行履歴（ステータス）とログ（`[cron:retention] purged {...件数}`／`purge failed <コード>`）。失敗しても再試行されないが、翌日の実行で期限切れの分をまとめて削除する。手動で確認したいときは「Run Schedule」で 1 回実行できる（何度実行しても期限切れの行だけが消える）。
- **CRON_SECRET の更新**：値を作り直して Production に登録 → 再デプロイ → 次の実行が `200` であることをログで確認する。古い値と新しい値を同時に受け付ける必要はない（Vercel は送る値とルートが読む値を同じデプロイから取る）。
- **ロールバック**（Instant Rollback）：戻した先のデプロイの Cron 設定と `CRON_SECRET` に戻る。切り替えの前後で 1 回分の実行漏れ・重複がありうるが、処理は何度呼ばれても安全。
- **毎月の確認**：Vercel の Usage（Functions の利用額）、Cron のログ、`owner_notification_batches` の送信結果、停止イベント（`npm run check:webhook-events`）。
- **WAF のカスタムルール**を追加する場合は、`/api/cron/owner-notify`・`/api/cron/retention` を拒否・チャレンジの対象から外す（外さないと Cron がブロックされる）。
- **Schedules への移行**：2026-11-13 に移行済み（Hobby で使える間隔にするため）。`crons` と併用しない（併用すると同じ時刻に 2 回呼ばれる）。Pro に変える場合は、間隔を短く（例：5 分）し、`jitter` を 1 にできる。
- **月 5,000 回の上限**：「Run Schedule」による手動実行も数えられる。上限に達するとその月の定期実行は止まる（翌月に再開）。

---

## 6. Hobby プランで使えるかの確認（2026-11-13）

| 項目 | Hobby の条件（Vercel 公式ドキュメント、2026-11-13 確認） | 本案件の設定 | 判定 |
|---|---|---|---|
| 利用目的 | 非商用・個人利用 | 学習課題（非商用） | 可 |
| Schedules の間隔 | 最短 15 分 | `*/15 * * * *` と `17 18 * * *`（1 日 1 回） | 可 |
| 実行時刻のずれ（jitter） | 常に 15 分の幅（指定しない） | 指定なし | 可 |
| 実行回数 | 月 5,000 回まで（ベータ） | 合計 月 3,007 回以内（31 日の月：96×31＋31） | 可 |
| 呼び出し方 | パスのターゲットは既定 POST。`requestMethod` で GET を指定できる。`Authorization: Bearer <CRON_SECRET>` が付く | 2 つとも GET を指定（ルートは GET だけを公開） | 可 |
| 実行される環境 | 本番（Production）。Preview は初期状態で無効 | Production だけで使う | 可 |
| Cron Jobs（`crons`） | 1 日 1 回まで | 使わない | — |
| 関数の最大実行時間 | 既定 300 秒 | `maxDuration = 60`（2 つの定期実行ルート） | 可 |

- 上の内容は `tests/notify/cron-route.test.ts` で自動確認している（`vercel.json` を変えたらテストが失敗する）。
- **関数の実行リージョン（2026-11-13 確認・設定済み）**：既定は米国東部（`iad1`）。Hobby も 1 リージョンなら選べるため、`vercel.json` の `regions` で東京（`hnd1`＝ap-northeast-1。Supabase と同じ）を指定した。
- **Schedules の回数の上限はチーム全体で数える**（Hobby：請求期間ごとに 5,000 回。手動実行も含む。超えるとその期間は実行されない）。同じアカウントのほかのプロジェクトに Schedules・Cron Jobs がある場合はその回数も合算されるため、デプロイ前にチームの Schedules の画面で確認する。
- 新しい静的スケジュールは、本番では有効の状態で作られる。ダッシュボードで Disable にした状態は、その後のデプロイでも保たれる。プロジェクトを Pause している間は実行されない（Vercel 公式ドキュメント、2026-11-13 確認）。
- **要確認**：Vercel の Deployment Protection（標準の保護）。本番のドメインは保護の対象外だが、デプロイごとの URL は保護される。**LINE の Webhook URL・`APP_BASE_URL` には本番のドメイン（`<プロジェクト名>.vercel.app` など）を使う。**

## 7. 環境変数の設定手順

一覧と各値の意味は [handover.md](./handover.md) 3 章。ここでは登録の手順だけを書く。

1. Vercel のプロジェクト → Settings → Environment Variables を開く。
2. 変数ごとに **Environment は Production だけ**を選ぶ（Preview・Development のチェックを外す）。秘密の値（`LINE_CHANNEL_SECRET`・`LINE_CHANNEL_ACCESS_TOKEN`・`SUPABASE_SERVICE_ROLE_KEY`・`ANTHROPIC_API_KEY`・`CRON_SECRET`）は **Sensitive** をオンにする。
3. 値は発行元の画面またはパスワード管理ツールからコピーして貼り付ける。チャット・メール・Git・メモ帳には貼らない。前後の空白・改行が入らないようにする。
4. 初回デプロイの値（下記 8 章の段階 1）：

   | 変数 | 値 |
   |---|---|
   | `LINE_CHANNEL_SECRET`・`LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers の値 |
   | `LINE_REPLY_MODE` | `dry-run` |
   | `LINE_RESPONDER` | `ai` |
   | `NEXT_PUBLIC_SUPABASE_URL`・`SUPABASE_URL` | `https://dnortggovlwgcdeoadbf.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | publishable key |
   | `SUPABASE_SERVICE_ROLE_KEY` | secret key |
   | `WEBHOOK_EVENT_STORE` | `supabase` |
   | `APP_BASE_URL` | `https://<本番のドメイン>` |
   | `ANTHROPIC_API_KEY`・`CLAUDE_MODEL`・`CRON_SECRET`・`ADMIN_WRITE_MODE`・`LINE_BROADCAST_MODE`・`ADMIN_ANSWER_TEST_MODE` | **登録しない**（空のまま） |

5. `NEXT_PUBLIC_` で始まる変数はビルド時に埋め込まれるため、**デプロイの前に**登録する。どの変数も、変更したら再デプロイするまで反映されない。
6. デプロイ後、Settings → Environment Variables で Preview・Development に値が入っていないことを確認する。

## 8. 初回デプロイの安全な順序と LINE Webhook URL の切り替え

### 8.1 デプロイしても勝手に動かないもの（2026-11-13 確認）

| 機能 | 初回デプロイ時の状態 | 根拠 |
|---|---|---|
| AI の自動応答 | **OFF のまま**。デプロイは DB を変更しない（`npm run build` は `next build` だけで、マイグレーション・データの登録をしない）。`bot_enabled` は DB の値で、現在 false | `package.json`、`verify.sql`（自動応答が OFF の項目） |
| お客様への返信 | `LINE_REPLY_MODE` が `live` でなければ送信しない（記録は `simulated`） | `tests/deploy/production-defaults.test.ts` |
| Claude API | 自動応答 OFF なら呼ばない。`ANTHROPIC_API_KEY` を登録しなければ呼べない | 同上・`tests/bot/` |
| 一斉配信・テスト送信・管理画面からの保存 | 安全スイッチを登録しなければすべて無効 | 同上 |
| 定期実行（通知・削除） | `CRON_SECRET` を登録しなければ 503 で、DB にも LINE にも接続しない | 同上 |
| 設定漏れ | `LINE_RESPONDER` の未設定・Supabase の接続情報なしは、Echo やメモリで代用せずエラー（返信しない） | 同上 |

### 8.2 段階ごとの手順（各段階の前にオーナーの承認を得る）

**段階 1：デプロイ（定期実行は無効のまま）**

1. ローカルで `npm run test` → `lint` → `typecheck` → `build` → `test:e2e` が通ることを確認する。
2. Vercel にプロジェクトを作り（Hobby）、7 章の値を登録する（`CRON_SECRET` は登録しない）。
   - **2026-11-13 決定：GitHub には push せず、Vercel CLI でデプロイする（プロジェクトに CLI のパッケージは追加しない）。具体的な操作は 9 章、デプロイ後の確認は 10 章。**
3. 本番へデプロイする。Schedules の 2 つは実行されるが、`503`（`{"ok":false,"error":"disabled"}`）を返すだけで何もしない（実行履歴には失敗として残る。問題なし）。
4. 確認（送信なし）：
   - `https://<本番のドメイン>/login` で管理画面にログインでき、ホームの「自動応答」の欄に「OFF（定型文のみ）」と表示される。
   - 認証なしで `/api/cron/retention`・`/api/cron/owner-notify` を開くと `503`。
   - `/api/line/webhook` に署名なしで POST すると `401`（例：`curl.exe -X POST https://<本番のドメイン>/api/line/webhook -d "{}"`）。

**段階 2：LINE Webhook URL の切り替え（dry-run のまま）**

1. LINE 公式アカウントの友だちが、オーナー役・テスト用のアカウントだけであることを確認する（dry-run の間はお客様に返信されないため）。
2. LINE Developers → 対象のチャネル → Messaging API 設定 → **Webhook URL** に `https://<本番のドメイン>/api/line/webhook` を入力して「更新」。
3. 「**検証**」を押して「成功」と表示されることを確認する（空のイベントが届き、200 を返す。返信はしない）。
4. 「**Webhook の利用**」を ON にする。
5. LINE 公式アカウントの管理画面 → 応答設定で、「応答メッセージ」（LINE 側の自動応答）を OFF、「Webhook」を ON にする。「あいさつメッセージ」は必要に応じて。
6. テスト用の LINE から文章を 1 つ送り、管理画面の会話ログに記録されること（返信は `simulated` で届かない）を確認する。
7. 元に戻すとき：「Webhook の利用」を OFF にする（Vercel 側の変更は不要）。

**段階 3：定期実行を有効にする（CRON_SECRET の登録）**

1. 削除される件数を先に確認する（読み取り専用。例：`supabase-setup.md` 8 本目の節のクエリ、または保持期間を超えた件数の集計）。
2. 3 章の手順で `CRON_SECRET` を作成し、Production に Sensitive で登録 → 再デプロイ。
3. 削除を急いで始めたくない場合は、`CRON_SECRET` を登録する**前に** Schedules で「retention」を **Disable** にしておき、件数を確認してから Enable にする（Disable の状態はその後のデプロイでも保たれる。削除されるのは保持期間を過ぎた行だけ）。
4. 15 分以内に「owner-notify」が `200`（`notification` は `dry_run`）になることを確認する。「retention」は翌日 3:17 ごろに `200`（件数）になることを確認する（「Run Schedule」で今すぐ 1 回実行してもよい）。

**段階 4：実機テスト（送信あり）**

- [line-device-test.md](./line-device-test.md) の手順で AC-07・AC-23・AC-24 を行う（`LINE_REPLY_MODE=live` などの切り替えと後片付けを含む。送信は 2〜3 通の見込み）。

**段階 5：初期データ・AI（課金あり）**

1. 初期データを登録する（`scripts/supabase/sample-data/sample-salon.sql`、または実際の店舗の情報を管理画面で入力）。
2. Anthropic Console で利用上限額を設定してから、`ANTHROPIC_API_KEY` を登録して再デプロイする。
3. 管理画面の「回答テスト」（`ADMIN_ANSWER_TEST_MODE=live`）で AC-12 の質問セットを確認してから、オーナーの承認を得て自動応答を ON にする。

## 9. Vercel CLI での初回デプロイ手順（Windows PowerShell）

8.2 の「段階 1」を、GitHub に push せずに行う手順。**実行はオーナーの承認後**。所要時間の目安は 30〜45 分。

### 9.0 事前に確認したこと（2026-11-13、読み取りのみ）

| 項目 | 結果 |
|---|---|
| Git | 作業ツリーに未コミットの変更なし（デプロイはローカルのファイルをそのままアップロードするため、コミット済みの状態で行う） |
| アップロードされるファイル | Vercel の既定で `.env.local`・`node_modules`・`.next`・`.git` などは除外。加えて `.vercelignore` で `.env*`・`.claude/`・`supabase/.temp/`・テスト結果を除外。残るのは Git 管理下のファイルと `next-env.d.ts` だけで、秘密情報のパターン検査で検出なし（テスト用のダミー値のみ） |
| Vercel CLI | パソコンへの常設のインストールはなし。`npx` のキャッシュに 65.2.0 があり、ログイン済み（アカウントのプランは hobby）。最新は 65.15.0 |
| 既存のプロジェクト | 同じアカウントに別のアプリのプロジェクトが 5 つある。`salon-line-bot` という名前のプロジェクトはない → **新しいプロジェクトを作る（既存のものにリンクしない）** |
| リージョン | `vercel.json` で `hnd1`（東京）を指定済み |
| ビルド時の DB 接続 | なし（静的生成・初期化処理なし。管理画面はリクエスト時に実行） |
| 本番 DB の基準値 | `scripts/supabase/deploy-snapshot.sql` を取得済み（自動応答 false・通知先あり・FAQ 0・メニュー 0・配信 0・管理者 1・会話 1・Webhook 記録 3・利用枠 0・通知記録 1） |

### 9.1 準備（PowerShell を新しく開く）

```powershell
$W = 'C:\path\to\salon-line-bot'   # このリポジトリのフォルダに置き換える
Set-Location $W
function vc { npx vercel@65.15.0 @args }   # このウィンドウだけで使う短縮名。バージョンを固定する

git status --short     # 何も表示されないこと（未コミットの変更がない）
git log --oneline -1   # デプロイするコミットを控えておく
vc --version           # 初回は「Need to install the following packages… Ok to proceed?」と聞かれたら y
vc whoami              # 自分のアカウント名が表示されること
```

- 秘密の値はコマンドに書かない（PowerShell の履歴に残るため）。この手順では値を**ダッシュボードで**登録する。
- `--yes`・`--force`・`--prebuilt` は使わない。

### 9.2 プロジェクトを作ってリンクする（まだデプロイしない）

```powershell
vc link
```

質問への答え（表示の文言は CLI の版で多少違う）：

| 質問 | 答え |
|---|---|
| Set up "…\salon-line-bot"? | `y` |
| Which scope / team? | 自分のアカウント（hobby） |
| Link to existing project? | **`n`**（既存の 5 つのプロジェクトにはリンクしない） |
| What's your project's name? | `salon-line-bot` |
| In which directory is your code located? | `./`（そのまま Enter） |
| 設定の自動検出（Next.js）を変更するか | `n`（変更しない） |

- リンクの情報は `.vercel/`（Git 管理外）に保存される。`git status --short` で何も増えていないことを確認する。
- この時点ではデプロイされない。ダッシュボード（https://vercel.com/dashboard）に `salon-line-bot` が表示されることを確認する。
- フレームワークと Node.js の版は、リポジトリの `vercel.json`（`"framework": "nextjs"`）と `package.json`（`engines.node: 24.x`）で指定している。ダッシュボードの設定（Framework Preset・Node.js Version）より、こちらが優先される。

### 9.3 環境変数を登録する

**方法 A（推奨）：PowerShell のスクリプトで一括登録する**（`scripts/vercel/register-env.ps1`。2026-11-13 追加）

- 9 項目だけを Production に登録する。秘密の 3 項目（`LINE_CHANNEL_SECRET`・`LINE_CHANNEL_ACCESS_TOKEN`・`SUPABASE_SERVICE_ROLE_KEY`）は Secret、残りは Config。
- 値は `.env.local` から読む（変更しない）。ただし `LINE_REPLY_MODE=dry-run`・`LINE_RESPONDER=ai`・`WEBHOOK_EVENT_STORE=supabase`・Supabase の URL はスクリプトの固定値を使う。
- 値は画面・履歴に出さず、Vercel CLI の標準入力で渡す。登録済みの変数は上書きしない。不足・空・形式違いがあれば何も登録せずに止まる。
- Windows PowerShell 5.1 では、そのままだと標準入力の先頭に BOM が付いて値が壊れるため、スクリプトで対策し、登録の前にダミーの値で受け渡しを確認する。

```powershell
Set-Location 'C:\path\to\salon-line-bot'   # このリポジトリのフォルダに置き換える
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\vercel\register-env.ps1          # 1. dry-run（登録しない）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\vercel\register-env.ps1 -Apply   # 2. 登録（dry-run の表を確認してから）
```

登録後、スクリプトが Production の変数名・種類・登録先だけを表示する。あわせて下の 4 の `vc env ls` でも確認する。

**方法 B：ダッシュボードで 1 つずつ登録する**

1. ダッシュボード → `salon-line-bot` → **Settings → Environment Variables**。
2. 7 章 4 の表の変数を 1 つずつ追加する。毎回、次を確認する：
   - **Environments は Production だけ**にチェック（Preview・Development のチェックを外す）。
   - 秘密の値（`LINE_CHANNEL_SECRET`・`LINE_CHANNEL_ACCESS_TOKEN`・`SUPABASE_SERVICE_ROLE_KEY`）は **Sensitive** をオン。
   - 値は `.env.local`（メモ帳などで開く）またはパスワード管理ツールからコピーする。前後に空白・改行を入れない。
3. **初回は登録しない**：`CRON_SECRET`・`ANTHROPIC_API_KEY`・`CLAUDE_MODEL`・`ADMIN_WRITE_MODE`・`LINE_BROADCAST_MODE`・`ADMIN_ANSWER_TEST_MODE`。`APP_BASE_URL` は本番のドメインが決まってから（9.5 の後、段階 3 の再デプロイのときでよい。dry-run の間は通知を送らないため影響なし）。
4. PowerShell で、登録した**名前**と環境を確認する（Sensitive の値は表示されない）：

   ```powershell
   vc env ls production
   ```

   次の 9 つが Production にあること：`LINE_CHANNEL_SECRET`・`LINE_CHANNEL_ACCESS_TOKEN`・`LINE_REPLY_MODE`（`dry-run`）・`LINE_RESPONDER`（`ai`）・`NEXT_PUBLIC_SUPABASE_URL`・`NEXT_PUBLIC_SUPABASE_ANON_KEY`・`SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY`・`WEBHOOK_EVENT_STORE`（`supabase`）。

   ```powershell
   vc env ls preview       # 何も表示されないこと
   vc env ls development   # 何も表示されないこと
   ```

### 9.4 デプロイ前の最終確認（読み取りのみ）

```powershell
npm run test; if ($?) { npm run lint }; if ($?) { npm run typecheck }; if ($?) { npm run build }
```

本番 DB の基準値を取る（10 章で比較する。結果を画面のスクリーンショットかメモで残す）：

```powershell
function sb { npx --yes supabase@3.1.0 --workdir $W @args }
sb db query --remote=dnortggovlwgcdeoadbf --read-only -f "$W\scripts\supabase\deploy-snapshot.sql"
```

### 9.5 本番へデプロイする

```powershell
vc deploy --prod
```

- アップロード → Vercel 上でのビルド（数分）→ 公開、の順に進む。ビルドに失敗した場合は公開されない（エラーの内容を控えて中止する）。
- 最後に表示される 2 つの URL を控える：
  - **Production**：`https://salon-line-bot…vercel.app`（本番のドメイン。名前が使われている場合は末尾に文字が付く）。**以降はこちらを使う**
  - **Inspect**：ダッシュボードのデプロイの詳細（ビルドのログ）
- デプロイごとの URL（`salon-line-bot-xxxx-….vercel.app`）には Vercel の保護（ログインが必要）がかかる。LINE・`APP_BASE_URL` には使わない。

デプロイの確認：

```powershell
vc ls salon-line-bot       # 一番上が Ready・Production であること
```

ダッシュボードで確認すること：

- Deployments の最新が **Ready** で、Environment が **Production**。
- デプロイの詳細（Resources・Functions）で、関数のリージョンが **hnd1（Tokyo）**。
- **Schedules** に `owner-notify` と `retention` が表示される（この時点では `CRON_SECRET` がないため、実行されても 503 で何もしない）。
- Settings → Deployment Protection：本番のドメインが保護の対象外であること（既定のまま）。

### 9.6 うまくいかないとき

| 現象 | 対応 |
|---|---|
| ビルドが `INVALID_CRON_SECRET` で失敗 | `CRON_SECRET` は初回は登録しない。登録してしまった場合は削除して再デプロイ |
| `No Output Directory named "public" found after the Build completed`（`STATIC_BUILD_NO_OUT_DIR`） | 2026-11-13 の初回デプロイで発生。プロジェクトのフレームワークが未設定（Other）で、Vercel が静的サイトとして扱ったため（`next build` 自体は成功していた）。`vercel.json` に `"framework": "nextjs"` を指定して解消する（指定済み）。公開されず、DB にも接続しないため、失敗したデプロイはそのままでよい |
| Node.js の版の違い | 新規プロジェクトの既定は 26.x だった。`package.json` の `engines.node` を `24.x`（ローカルの検証と同じ）に指定済み |
| ビルドが Schedules・regions の設定で失敗 | エラーの内容を控えて中止（`vercel.json` を勝手に変えない）。保守担当者が確認する |
| 本番のドメインで Vercel のログイン画面が出る | Deployment Protection の設定を確認する（本番のドメインを保護する設定になっていないか） |
| すぐにやめたい | ダッシュボード → `salon-line-bot` → **Settings → General** の **Pause Project**（Delete Project の上）→ プロジェクト名を入力して確定。一時停止中は本番の URL が 503（DEPLOYMENT_PAUSED）を返し、Schedules も実行されない。再開は同じ場所の **Resume Project**（再デプロイ不要）。2 回目以降のデプロイなら、Deployments で直前のデプロイに **Instant Rollback** もできる |

## 10. デプロイ後の安全確認チェックリスト

`<ドメイン>` は 9.5 で控えた本番のドメイン。すべて**読み取り・閲覧だけ**で確認する（保存ボタンは押さない）。

| # | 確認すること | 方法 | 合格の条件 |
|---|---|---|---|
| 1 | 管理画面が表示される | ブラウザで `https://<ドメイン>/login` | ログイン画面が表示される |
| 2 | オーナーがログインできる | オーナーのメールアドレス・パスワードでログイン | ホーム画面が表示される。ログインで記録されるのは Supabase Auth のセッションだけ（public のテーブルは変わらない） |
| 3 | 未ログインでは管理画面に入れない | ブラウザの**シークレットウィンドウ**で `https://<ドメイン>/admin` と `/admin/faqs` を開く | どちらもログイン画面に移る。データは表示されない |
| 4 | 自動応答が OFF | ホームの「自動応答」の欄 | 「OFF（定型文のみ）」 |
| 5 | 管理画面からの保存が無効 | 「店舗情報・設定」を開く（押さない） | 「書き込みは無効になっています（安全のための初期設定）…」と表示され、保存ボタンが押せない |
| 6 | LINE の実送信が無効 | ① `vc env ls production` で `LINE_REPLY_MODE` があり、`LINE_BROADCAST_MODE` がない ②「お知らせ配信」を開く | ② 「LINE への送信は無効になっています（安全のための初期設定）…」と表示される。LINE の Webhook URL はまだ切り替えていないため、お客様のメッセージも届かない |
| 7 | Claude API の実呼び出しが無効 | ① `vc env ls production` に `ANTHROPIC_API_KEY` がない ②「回答テスト」を開く（送信はしない） | ① ない ② 「現在は AI を呼び出しません（費用はかかりません）。…」と表示される。自動応答も OFF のため、AI は呼ばれない |
| 8 | 定期実行が認証設定なしでは何もしない | 下のコマンド | 2 つとも `HTTP 503` と `{"ok":false,"error":"disabled"}` |
| 9 | Webhook が署名なしの要求を拒否する | 下のコマンド | `HTTP 401`（`500` の場合は環境変数の設定漏れ。`LINE_RESPONDER`・`LINE_CHANNEL_SECRET`・Supabase の変数を確認する。この場合も処理は何も行われない） |
| 10 | Schedules の実行履歴 | ダッシュボード → Schedules → 各スケジュール | 実行されていれば結果は 503（失敗として表示されるが、DB にも LINE にも接続していない） |
| 11 | 本番 DB のデータに変更がない | 9.4 と同じ `deploy-snapshot.sql` を実行 | 9.4 の結果とすべての行が同じ（2026-11-14 に「要通知・未通知の件数」を加えて 13 行） |
| 12 | 権限・RLS が変わっていない | `sb db query --remote=dnortggovlwgcdeoadbf --read-only -f "$W\scripts\supabase\verify.sql"` | 136 項目すべて OK |

8・9 のコマンド（PowerShell。`curl.exe` は Windows に標準で入っている）：

```powershell
$D = 'https://<ドメイン>'   # 9.5 で控えた本番のドメインに置き換える
curl.exe -s -w "  HTTP %{http_code}`n" "$D/api/cron/retention"
curl.exe -s -w "  HTTP %{http_code}`n" "$D/api/cron/owner-notify"
curl.exe -s -o NUL -w "HTTP %{http_code}`n" -X POST "$D/api/line/webhook" -H "Content-Type: application/json" -d "{}"
```

- すべて合格したら、結果（日時・ドメイン・各項目の合否）を記録し、段階 2（LINE Webhook URL の切り替え）の承認に進む。
- 1 つでも不合格なら、その時点で止めて報告する。止める方法は 9.6 の「すぐにやめたい」、または [handover.md](./handover.md) 5 章。

## 11. 定期実行（通知・削除）を有効にする（段階 3・2026-11-14 準備）

`CRON_SECRET` と `APP_BASE_URL` を登録して再デプロイし、定期通知（15 分ごと）と定期削除（毎日 03:17 JST ごろ）を**まとめて**有効にする。**実行はオーナーの承認後**。

### 11.1 有効にしても変わらないこと

- 返信は `LINE_REPLY_MODE=dry-run` のまま。**定期通知は `notification: "dry_run"` を返すだけで、LINE にも DB にも何もしない**（未通知のイベントは未通知のまま残る）。オーナーに通知が届き始めるのは、段階 4 で `live` にしたとき
- 自動応答（`bot_enabled = false`）・AI（`ANTHROPIC_API_KEY` 未登録）・安全スイッチ（未登録）は変わらない
- 定期通知が DB に書き込むのは、処理が 5 分以上止まったイベントを「停止」に変えるときだけ（現在は該当なし）

### 11.2 定期削除で消えるもの（2026-11-14 14:06 JST に読み取り専用で確認）

削除されるのは、保持期間を過ぎた後の最初の実行（毎日 18:17 UTC＝03:17 JST。最大 15 分遅れる）。

| データ | 受信・作成（JST） | 保持期限（JST） | 削除される実行（JST） | 備考 |
|---|---|---|---|---|
| Webhook の記録 | 11/11 16:18 | 11/18 16:18 | **11/19 03:17** | 開発中の受信テスト |
| Webhook の記録 | 11/11 16:42 | 11/18 16:42 | **11/19 03:17** | 開発中の受信テスト |
| Webhook の記録 | 11/12 23:52 | 11/19 23:52 | 11/20 03:17 | 通知済み |
| Webhook の記録 | 11/14 13:56 | 11/21 13:56 | 11/22 03:17 | **要通知・未通知**（本番の受信テスト）。段階 4 の live までに通知されなければ、通知されないまま消える（会話は未対応一覧に残る） |
| 通知の記録 | 11/12 23:52 | 12/12 23:52 | 12/13 03:17 | 送信済み |
| 会話 | 11/12 23:52 | 2027/02/10 23:52 | 2027/02/11 03:17 | 未対応のまま |
| 会話 | 11/14 13:56 | 2027/02/12 13:56 | 2027/02/13 03:17 | 未対応のまま |

- 現時点で保持期間を過ぎたデータは **0 件**。11/15 03:17 の最初の実行は、何も削除しない（件数はすべて 0）
- 管理者・店舗情報・FAQ・メニュー・配信は削除しない
- 定期削除だけを止めたい場合は、Vercel の Schedules で「retention」を Disable にする（デプロイ後も保たれる）

### 11.3 手順（Windows PowerShell）

```powershell
$W = 'C:\path\to\salon-line-bot'   # このリポジトリのフォルダに置き換える
Set-Location $W
function vc { npx vercel@65.15.0 @args }
function sb { npx --yes supabase@3.1.0 --workdir $W @args }

# 1. 事前の記録（読み取りのみ）。結果を控える
git status --short     # 何も表示されないこと
sb db query --remote=dnortggovlwgcdeoadbf --read-only -f "$W\scripts\supabase\deploy-snapshot.sql"

# 2. 登録の dry-run（登録しない）。表に CRON_SECRET（Secret）と APP_BASE_URL（Config）が出ること
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\vercel\register-cron.ps1

# 3. 登録（Production のみ。CRON_SECRET はスクリプトが乱数で作り、表示・保存しない）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\vercel\register-cron.ps1 -Apply

# 4. 再デプロイ（登録した値はデプロイするまで反映されない）
vc deploy --prod
```

- `CRON_SECRET` の元の値は保存しない（2026-11-14 決定）。Vercel が定期実行のたびに自動で付けるため、運用では使わない。作り直すときは、ダッシュボードで `CRON_SECRET` を削除 → 3 をもう一度 → 再デプロイ。
- 4 で `INVALID_CRON_SECRET` のエラーになった場合は、ダッシュボードで `CRON_SECRET` を削除して 3 からやり直す。

### 11.4 再デプロイ後の確認

```powershell
$D = 'https://salon-line-bot-nine.vercel.app'
# 5. 認証なしの要求は 503 ではなく 401 になる（CRON_SECRET が有効になった）
curl.exe -s -w "  HTTP %{http_code}`n" "$D/api/cron/owner-notify"
curl.exe -s -w "  HTTP %{http_code}`n" "$D/api/cron/retention"

# 6. 15〜30 分後：定期通知の最新の実行が成功（succeeded）になっている
vc schedules executions list owner-notify --since 1h

# 7. 事前の記録と比べる（13 行すべて同じ。「要通知・未通知の件数」は 1 のまま）
sb db query --remote=dnortggovlwgcdeoadbf --read-only -f "$W\scripts\supabase\deploy-snapshot.sql"
```

| # | 確認すること | 合格の条件 |
|---|---|---|
| 5 | 認証なしの要求 | 2 つとも `HTTP 401` と `{"ok":false,"error":"unauthorized"}` |
| 6 | 定期通知の実行 | 再デプロイ後の実行が `succeeded`（ログは `notification: "dry_run"`。LINE には送らない） |
| 7 | 本番 DB | 事前の記録と 13 行すべて同じ（新しい受信があった場合は、その分だけ増える） |
| 8 | 定期削除の最初の実行 | 翌日 03:17〜03:32 JST の実行が `succeeded`。Vercel のログに `[cron:retention] purged` と件数（11/18 までは 0 件）。確認は `vc schedules executions list retention --since 1d` |
| 9 | 環境変数 | `vc env ls production` に 11 項目（9 項目＋`CRON_SECRET`・`APP_BASE_URL`）。Preview・Development には何もない |

- 定期削除を手動で実行（「Run Schedule」・`vc schedules invoke`）はしない。最初の実行は 8 の定期の実行で確認する。
- 失敗した場合の止め方：Schedules で該当のスケジュールを Disable（すぐ止まる・再デプロイ不要）。
