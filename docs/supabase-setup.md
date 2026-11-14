# Supabase マイグレーション適用手順書

対象：**salon-line-bot**（Project Ref `dnortggovlwgcdeoadbf`／リージョン ap-northeast-1 Tokyo）

この手順書は「適用前の確認 → 適用 → 適用後の確認 → 環境変数の設定」を、同じアカウントのほかの Supabase プロジェクトに影響を与えずに行うためのものです。
**手順 8（本番 DB への適用）はオーナーの承認を得てから実行します。**

---

## 1. 適用するマイグレーション

| 順 | ファイル | 内容 |
|---|---|---|
| 1 | `supabase/migrations/20261110000000_initial_schema.sql` | `private` スキーマ、7 テーブル、RLS・ポリシー、列単位の GRANT、トリガー、配信・保持期間の関数、`shop_settings` の初期 1 行 |
| 2 | `supabase/migrations/20261110010000_webhook_event_processing.sql` | `line_webhook_events` に処理状況の列・制約・インデックスを追加し、service_role 専用の関数 5 つを作成 |
| 3 | `supabase/migrations/20261110020000_grant_service_role.sql` | service_role のテーブル権限をいったん剥奪し、サーバー処理に必要な操作だけを明示的に付与（理由は下記） |
| 4 | `supabase/migrations/20261111000000_reply_status_simulated.sql` | `reply_status` に `simulated`（dry-run・未送信）を追加し、`record_line_reply_result` で受け付ける。2026-11-11 に本番へ適用済み（§7） |
| 5 | `supabase/migrations/20261112000000_conversation_ai_sources.sql` | `conversations` に AI 回答の根拠（`source_faq_ids`・`source_menu_ids`・`source_shop_fields`）と判定理由（`ai_reason`）の列を追加。2026-11-11 に本番へ適用済み（§7） |
| 6 | `supabase/migrations/20261113000000_ai_usage_limits.sql` | Claude API の利用回数制限：`ai_usage_reservations`（利用枠の記録。LINE ユーザー ID は SHA-256 のハッシュ値のみ・2 日で削除）と `reserve_ai_usage`（確認と確保をアドバイザリーロックで直列化）。service_role 専用。2026-11-12 に本番へ適用済み（下記） |
| 7 | `supabase/migrations/20261114000000_owner_notifications.sql` | オーナー通知（WBS 2.5）：`owner_notification_batches`（まとめ送信の記録。イベント ID とコードのみ・30 日で削除）と `claim_owner_notification_batch`（間隔・1 日の上限・同時実行をロックで判定）・`finish_owner_notification_batch`（結果の記録・通知日時の記録）。service_role 専用。2026-11-12 に本番へ適用済み（下記） |
| 8 | `supabase/migrations/20261115000000_retention_purge.sql` | 保持期間を過ぎたデータの削除の入口 `public.run_retention_purge()`（引数なし・保持期間固定・件数のみ返す・service_role 専用）。2026-11-13 に本番へ適用済み（下記） |

### 8 本目（保持期間の削除）について

- 目的：Vercel Schedules（1 日 1 回）から `/api/cron/retention` 経由で、会話ログ 90 日・Webhook イベント 7 日・利用枠 2 日・通知記録 30 日を過ぎたデータを削除する。仕様は `docs/architecture.md` 6.6。
- 関数を 1 つ追加するだけで、既存のテーブル・関数・権限は変更しない（PGlite で、7 本目まで適用した状態と比べて追加のみであることを確認済み）。
- **未適用のまま `retention` の定期実行がデプロイされると、毎日 500 になり何も削除されない**（ほかの機能には影響しない）。
- 適用後は `verify.sql`（8 本目で確認項目を追加。適用前は 135 項目中 3 項目が NG、適用後は 136 項目すべて OK の見込み）、`npm run gen:types` で型を再生成し `src/types/database.ts` の `run_retention_purge` の一時的な定義を削除すること。
- **適用すると、次の定期実行で期限切れのデータが実際に削除される**（削除したデータは戻らない）。適用前に、削除される件数を読み取り専用で確認しておく（例：`select count(*) from public.conversations where created_at < now() - interval '90 days'`）。
- 取り消し（通常は使わない）：`scripts/supabase/rollback/20261115000000_retention_purge.down.sql`。
- 2026-11-13 の事前確認（読み取り専用）：接続先・`check-target.ps1` は問題なし、`migration list` は 7 本一致・8 本目のみ未適用、従来の `verify.sql` 132 項目すべて OK（8 本目の項目を加えた版は 135 項目中 NG 3 件で、すべて未適用の 8 本目の項目）、保持期間を超えたデータは全テーブル 0 件、関数名・ロックのキーは未使用、`db push --dry-run` の対象は 8 本目の 1 本だけ。
- 2026-11-13 にオーナーが本番へ適用。適用後の確認（読み取り専用）：`migration list` は 8 本一致、`verify.sql` 136 項目すべて OK、`run_retention_purge` は SECURITY INVOKER・`search_path=''`・EXECUTE は service_role のみ（anon／authenticated は不可）で本体はマイグレーションと一致（md5）、`db advisors` は WARN 1 件（Auth の Leaked Password Protection が無効。8 本目とは無関係の Auth 設定。Pro 以上の機能のため、学習課題では有効にせず**無料プランの制約として記録**：handover.md 6 章・wbs.md 6.5）・ERROR なし。関数は実行していない（最初の実行はデプロイ後の定期実行）。`npm run gen:types` で再生成し、一時的な定義は削除した。

### 7 本目（オーナー通知）について

- 目的：要オーナー対応のイベント（`line_webhook_events.needs_owner_notification`）を、オーナーの LINE へまとめて push する。仕様は `docs/architecture.md` 6.4。
- 既存のテーブル・関数・権限は変更しない（PGlite で、6 本目まで適用した状態と比べて追加のみであることを確認済み）。`owner_notified_at` の更新には 3 本目で service_role に付与済みの UPDATE を使う。
- **未適用のまま `LINE_REPLY_MODE=live` にすると、まとめを確保できず通知は送られない**（エラーログのみ。お客様への返信・会話ログには影響しない）。dry-run（既定）では DB に接続しないため影響しない。
- 適用後は `verify.sql`（7 本目で 14 項目追加。適用前は 130 項目中 11 項目が NG、適用後は関数の search_path の 2 項目が加わり 132 項目すべて OK の見込み）、`npm run gen:types` で型を再生成し `src/types/database.ts` の 2 関数の一時的な定義を削除すること。
- 通知先の登録：`shop_settings.owner_line_user_id` に、オーナーの LINE ユーザー ID（`U` + 16 進 32 文字）を設定する（管理画面（WBS 3.3）の実装までは、オーナーの承認を得て保守担当が設定する。本番への書き込みのため要承認）。オーナーは事前に LINE 公式アカウントを友だち追加しておく（ブロック中・未追加だと push は届かない）。ユーザー ID はチャネルのプロバイダーごとに異なるため、本番の公式アカウントと同じプロバイダーのものを使う。取得方法（LINE Developers コンソールの「あなたのユーザー ID」等）は**要確認**。
- 取り消し（通常は使わない）：`scripts/supabase/rollback/20261114000000_owner_notifications.down.sql`。
- 適用前チェック（読み取り専用）：`sb db query --remote=$REF --read-only -f "$W\scripts\supabase\precheck-owner-notifications.sql"` で全行 OK（履歴 6 本・追加するテーブル／関数／インデックス／ロックのキーが未使用・依存する列と権限・分離レベル・bot_enabled=false など。通知先は有無だけを表示）。
- 2026-11-12 の事前確認（読み取り専用）：precheck 全 18 項目 OK（通知先は未設定、適用後の最初の通知の対象 0 件）、`verify.sql` は 130 項目中 119 OK（NG 11 は未適用の 7 本目の項目のみ。既存 118 項目は全 OK）、`db push --dry-run` の対象は `20261114000000_owner_notifications.sql` の 1 本だけ。
- 2026-11-12 にオーナーが本番へ適用。適用後の確認（読み取り専用）：`migration list` は 7 本一致、`verify.sql` 132 項目すべて OK、`owner_notification_batches` は RLS 有効・ポリシー 0・service_role は SELECT／INSERT／UPDATE／DELETE のみ・anon／authenticated は権限なし・0 行、2 関数は SECURITY INVOKER・`search_path=''`・EXECUTE は service_role のみで本体はマイグレーションと一致、`db advisors` は INFO のみ（WARN・ERROR なし）。`npm run gen:types` で再生成し、一時的な定義は削除した。通知先（owner_line_user_id）は未設定のため、通知はまだ送られない。

### 6 本目（AI 利用回数制限）について

- 目的：大量のメッセージや同時リクエストで Claude API の呼び出し回数が想定外に増えることを防ぐ。**回数の上限であり、請求金額の上限を保証するものではない**（1 回あたりの費用は質問・登録情報の長さで変わる。金額の上限は Anthropic の管理画面の利用上限で別途設定する）。
- 初期値（日本時間基準）：同一ユーザー 10 分間に 5 回・1 日 30 回、店舗全体 1 日 300 回（`src/lib/ai/usage-limit.ts` の `AI_USAGE_LIMITS`）。上限到達・確認失敗時は AI を呼ばず定型文（`USAGE_LIMIT_MESSAGE`）を返し、会話ログの `error_message` に `usage_*` のコードを記録する。
- 既存のテーブル・関数・権限は変更しない（PGlite で、5 本目まで適用した状態と比べて追加のみであることを確認済み）。
- **未適用のまま `LINE_RESPONDER=ai` にすると、利用枠を確認できないため AI は呼ばれず、すべて定型文になる**（安全側）。既定の echo では影響しない。
- 適用後は `verify.sql` の追加項目（区分 1〜10 の ai_usage_reservations・reserve_ai_usage と、区分 15 の 2 項目）が OK になること、`npm run gen:types` で型を再生成すること（`src/types/database.ts` の reserve_ai_usage の一時的な定義を整理する）。
- 取り消し（通常は使わない）：`scripts/supabase/rollback/20261113000000_ai_usage_limits.down.sql`。
- 適用前チェック（読み取り専用）：`sb db query --remote=$REF --read-only -f "$W\scripts\supabase\precheck-ai-usage-limits.sql"` で全行 OK（履歴 5 本・追加するテーブル／関数／インデックスが未作成・RLS・anon 権限なし・分離レベル read committed・sha256／Asia/Tokyo が使える・bot_enabled=false など）。
- 2026-11-12 の事前確認（読み取り専用）：precheck 全 13 項目 OK、`verify.sql` の既存 107 項目は全 OK（NG は未適用の 6 本目の項目のみ）、`db push --dry-run` の対象は `20261113000000_ai_usage_limits.sql` の 1 本だけ。
- 2026-11-12 にオーナーが本番へ適用。適用後の確認（読み取り専用）：`migration list` は 6 本一致、`verify.sql` 118 項目すべて OK、`ai_usage_reservations` は RLS 有効・ポリシー 0・service_role は SELECT／INSERT／DELETE のみ・anon／authenticated は権限なし・0 行、`reserve_ai_usage` は SECURITY INVOKER・`search_path=''`・EXECUTE は service_role のみで関数本体はマイグレーションと一致、`db advisors` は INFO のみ（RLS 有効でポリシーなし＝意図どおり、未使用インデックス＝利用実績がないため）。`npm run gen:types` で再生成し、一時的な定義は削除した。

### 5 本目（conversations の根拠列）について

- 目的：AI 応答（`LINE_RESPONDER=ai`）で、どの FAQ・メニュー・店舗情報の項目を根拠に回答したかを会話ログに残す。ID は外部キーにせず（FAQ・メニューを削除してもログは残す）、店舗項目は許可リストで制限する。
- 権限の変更はない（3 本目のテーブル単位の付与で service_role は insert 可。authenticated が更新できる列は増やさない）。
- 未適用のまま `LINE_RESPONDER=ai` にすると、会話ログの保存が列不足で失敗する（返信自体は止まらない）。**AI 応答を有効にする前に適用する。** 既定の `LINE_RESPONDER`（echo）では影響しない。
- 適用手順は 4 本目と同じ（`db push --dry-run` で 5 本目だけが対象であることを確認し、オーナーが実行）。適用後は `verify.sql` の「conversations に AI 回答の根拠の列（5 本目のマイグレーション）」が OK になること、`npm run gen:types` で型を再生成すること（2026-11-11 に再生成済み。`src/types/database.ts` には `source_shop_fields` の許可リストの絞り込みだけを残した）。
- 適用前チェック（読み取り専用）：`sb db query --remote=$REF --read-only -f "$W\scripts\supabase\precheck-conversation-sources.sql"` で全行 OK（履歴 4 本・追加列と制約名が未作成・権限・RLS・bot_enabled=false など）。
- 取り消し（通常は使わない）：`scripts/supabase/rollback/20261112000000_conversation_ai_sources.down.sql` を、オーナーの承認後に SQL Editor で実行する（追加 4 列のデータは失われる。適用履歴は変更しない）。PGlite で適用前と同じ状態に戻ることを確認済み。
- 2026-11-11 の事前確認（読み取り専用）：`migration list` は 4 本適用済み・5 本目のみ未適用、precheck 全 14 項目 OK（conversations 0 行）、`verify.sql` は 107 項目中 106 OK（NG は未適用の 5 本目の項目のみ）、`db push --dry-run` の対象は `20261112000000_conversation_ai_sources.sql` の 1 本だけ。

### 4 本目（reply_status = simulated）について

- 目的：`LINE_REPLY_MODE=dry-run` の返信処理の完了を、LINE が受理した `sent` と区別して `simulated` と記録する（以前は dry-run でも `sent` になっていた）。
- 未適用のまま新しいコードを動かすと、dry-run の結果記録が DB 関数に拒否され、`reply_status` は `unknown`（成否不明）として残る。LINE への二重送信は起きないが、実機の dry-run テストの前に適用する。
- 適用手順は 1〜3 本目と同じ（手順 3〜9。`db push --dry-run` で 4 本目だけが対象であることを確認し、オーナーが実行）。適用後は `verify.sql` の「reply_status に simulated（dry-run）を許可」が OK になること、`npm run gen:types` で型を再生成すること（関数の引数型は text のままなので生成型の差分はない想定）。

### 依存関係（レビュー結果）

- 2 本目は 1 本目の `line_webhook_events` と、PostgreSQL が自動で付けた制約名（`line_webhook_events_status_check`・`line_webhook_events_check`）に依存する。ファイル名の時刻順に適用すれば満たされる（PGlite で同じ名前になることを確認済み）。
- Supabase 側に存在が必要なもの：ロール `anon`／`authenticated`／`service_role`、`auth.users`、`auth.uid()`、`gen_random_uuid()`。→ `preflight.sql` で確認する。
- **service_role のテーブル権限は 3 本目で明示的に付与する。** 2026-11-10 に対象プロジェクトの既定権限を読み取り専用で確認したところ、postgres が public に作るテーブルへ自動で付くのは anon／authenticated／service_role とも MAINTAIN・REFERENCES・TRIGGER・TRUNCATE だけで、SELECT・INSERT・UPDATE・DELETE は付かなかった。1・2 本目だけでは Webhook 用の関数が `permission denied` になる。3 本目の付与内容：line_webhook_events・conversations は SELECT/INSERT/UPDATE、broadcasts は SELECT/UPDATE、shop_settings・faqs・menus は SELECT、admin_users はなし（DELETE・TRUNCATE は付けない）。PGlite のテストもこの既定権限に合わせている（`tests/db/pglite.ts`）。
- 関数の実行権限はすべてマイグレーション内で明示的に設定している（`public`・`anon`・`authenticated` から剥奪し、service_role にだけ付与。`private.is_admin()` だけは RLS 判定のため authenticated にも付与）。
- `line_webhook_events` は RLS 有効・ポリシーなし（service_role 専用）。Supabase の Security Advisor で「RLS Enabled No Policy」と表示されるが、意図どおり。
- `supabase/migrations/.gitkeep` は CLI に無視される（警告が出る場合がある）。

## 2. 適用方法の比較と推奨

| 方法 | 長所 | 短所 |
|---|---|---|
| **Supabase CLI（推奨）** | `--remote=<Ref>` で接続先を毎回明示できる。`--dry-run` で事前確認できる。適用履歴（`supabase_migrations.schema_migrations`）が残り、今後の追加マイグレーションを差分で適用できる | CLI の取得とアクセストークンが必要 |
| ダッシュボードの SQL エディタに貼り付け | URL にプロジェクト Ref が入るので接続先が目で確認しやすい | 適用履歴が残らない。貼り付けミスの検出が難しい。今後 CLI に移行するときに履歴の修正が必要 |

**推奨：CLI を `npx supabase@3.1.0`（バージョン固定）で使う。** `package.json` には追加しない（不要なパッケージを増やさないため）。
`supabase link` は使わず、**すべてのコマンドに `--workdir` と `--remote=dnortggovlwgcdeoadbf` を明示する。** こうすると、カレントディレクトリやリンク状態の取り違えで別プロジェクトに適用する事故が起きない。

> CLI 3.1.0 のヘルプで確認済み：`--workdir`（親ディレクトリを探索しない）、`db push --dry-run`／`--remote=<ref>`／`--skip-vault`、`db query --read-only -f`、`migration list --remote`、`gen types --remote`。
> 未確認：`--password` を省略したときにアクセストークンだけで適用できるか（ヘルプ上は scoped token の `database_write` 権限で可能と読める）、`config.toml` がない状態で `db push` が動くか、1 ファイルが 1 トランザクションで実行されるか。

## 3. ほかのプロジェクトに影響させないための決まり

1. コマンドは必ず下記の関数 `sb` 経由で実行する（`--workdir` を固定）。
2. リモートを対象にするコマンドには必ず `--remote=$REF` を付ける。付け忘れた場合はローカル DB（Docker）が対象になり、Docker がないので失敗する＝安全側。
3. **`supabase login` は実行しない。** この PC の資格情報マネージャーには既に Supabase CLI のトークンが保存されている（ほかのプロジェクトで使用中の可能性）。上書きしないよう、このプロジェクトでは環境変数 `SUPABASE_ACCESS_TOKEN` を**その PowerShell ウィンドウの間だけ**使う。
   - 可能なら、ダッシュボードで本プロジェクトだけに権限を絞ったトークン（scoped token）を作成する（作成画面で選べるかは要確認）。
4. **`--yes` や環境変数 `SUPABASE_YES` は使わない。** `db push` の確認プロンプトで、対象 Ref と適用ファイルを目で確認してから `y` を押す。
5. `supabase link` を使った場合も、リンク情報は `salon-line-bot\supabase\.temp\project-ref` にだけ保存され、ほかのプロジェクトのフォルダには書き込まれない。
6. **適用前チェック（preflight.sql）で public スキーマにテーブルが 1 つでもあれば中止する。** ほかのプロジェクトに誤って接続した場合は、既存テーブルがあるため必ず NG になる。

### 使ってはいけないコマンド

| コマンド | 理由 |
|---|---|
| `supabase db reset --remote ...` | リモート DB を全削除する |
| `supabase login` | 保存済みのトークンを上書きし、ほかのプロジェクトの作業に影響する |
| `supabase migration repair` | 適用履歴を書き換える（必要になったら相談） |
| `supabase link`（ほかのフォルダで） | 別プロジェクトのリンク状態を変える |
| `--yes`／`SUPABASE_YES=1` | 確認なしで本番に変更が適用される |
| **`supabase config push`** | **実行しない。** `supabase/config.toml` は `supabase init` が作ったローカル開発用の既定値（Site URL が 127.0.0.1、新規登録が許可、メール確認・二段階認証が無効など）で、本番より緩い。push すると本番の認証設定がこの値で上書きされる。本番の設定はダッシュボードで変更する。差分の確認は読み取り専用の `supabase config diff --remote=<Ref>` で行う |
| `supabase pull`／`supabase db pull` | 本番からローカルのマイグレーションや設定を書き換え、リモートの履歴にも記録する（必要になったら相談） |
| パスワード・キーをコマンドライン引数に書く（`-p xxx` 等） | コマンド履歴やログに残る |

## 4. 実行手順

PowerShell を新しく開き、そのウィンドウだけで作業する（作業後に閉じれば環境変数も消える）。

### 手順 0：共通設定とローカル確認（接続しない）

```powershell
$W   = 'C:\path\to\salon-line-bot'   # このリポジトリのフォルダに置き換える
$REF = 'dnortggovlwgcdeoadbf'
function sb { npx --yes supabase@3.1.0 --workdir $W @args }
Set-Location $W

git status --short          # 未コミットの変更がないこと
npm run test                # 全テスト合格（tests/db/check-scripts.sql.test.ts を含む）
sb --version                # 3.1.0
```

### 手順 1：CLI の設定ファイルを作る（ローカルのみ・初回だけ）

```powershell
if (-not (Test-Path "$W\supabase\config.toml")) { sb init }
```

作成された `supabase/config.toml` の `project_id` を `salon-line-bot` にする。`supabase/migrations/` は変更されない（スクラッチディレクトリで動作確認済み：作成されるのは `config.toml` と `.temp/` のみ）。

### 手順 2：アクセストークンをこのウィンドウにだけ設定する

ダッシュボード（Account → Access Tokens）で、この作業用のトークンを作成する。名前は `salon-line-bot-migration` など、用途がわかるものにする。

```powershell
$sec = Read-Host 'Supabase access token' -AsSecureString   # 入力は表示されず、履歴にも残らない
$env:SUPABASE_ACCESS_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
Remove-Variable sec
```

### 手順 3：対象プロジェクトの確認（読み取りのみ）

```powershell
sb projects list
```

一覧の中で次の 3 点がそろう行があることを確認する。ほかのプロジェクトも表示されるが、操作はしない。

- REFERENCE ID が `dnortggovlwgcdeoadbf`
- NAME が `salon-line-bot`
- REGION が Tokyo（ap-northeast-1）

続いてローカル設定を確認する（ネットワーク接続なし・キーの値は表示しない）。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\supabase\check-target.ps1
```

`結果: 問題なし` 以外なら中止する。

### 手順 4：適用前チェック（読み取り専用）

```powershell
sb db query --remote=$REF --read-only -f "$W\scripts\supabase\preflight.sql"
```

- **NG が 0 件**で、要確認の行を確認済みなら次へ進む。新規プロジェクトでは「既定権限」の行が要確認になる（3 本目で解決する。適用後に `verify.sql` の区分 5 で確認）。
- 「public スキーマにテーブル・ビューが 1 つもない」が NG → **別プロジェクトに接続している可能性。中止する。**
- 「既定権限：新規テーブルに service_role …」が要確認 → 手順 5 の dry-run に `20261110020000_grant_service_role.sql` が含まれていることを確認する。
- 要確認の行は内容を見て判断する（例：マイグレーション履歴テーブルが既にある → 手順 5 で履歴が空か確認）。

CLI を使わない場合は、`https://supabase.com/dashboard/project/dnortggovlwgcdeoadbf/sql/new` を開き、**URL の Ref を確認してから** `preflight.sql` を貼り付けて実行する（SELECT 1 文のみでデータは変更しない）。

### 手順 5：適用予定の確認（変更しない）

```powershell
sb migration list --remote=$REF               # Local に 3 本、Remote は空
sb db push --remote=$REF --skip-vault --dry-run   # 適用予定がちょうど 3 本で、ファイル名が一致すること
```

### 手順 6：オーナーの承認

手順 3〜5 の結果（Ref・プロジェクト名・preflight の NG 0 件・dry-run の 3 本）を報告し、適用の承認を得る。

### 手順 7：（承認後）適用前にもう一度ローカル確認

```powershell
powershell -ExecutionPolicy Bypass -File scripts\supabase\check-target.ps1
git status --short   # マイグレーションに未コミットの変更がないこと
```

### 手順 8：（承認後）適用

```powershell
sb db push --remote=$REF --skip-vault
```

確認プロンプトに表示される接続先と適用ファイル 3 本を確認してから `y` を入力する。DB パスワードを求められた場合は、プロンプトに直接入力する（引数には書かない）。

### 手順 9：適用後の確認（読み取り専用）

```powershell
sb migration list --remote=$REF   # Local と Remote の両方に 3 本
sb db query --remote=$REF --read-only -f "$W\scripts\supabase\verify.sql"   # 全行 OK
```

あわせて、下記「5. 適用後チェックリスト」の画面確認を行う。

### 手順 10：型の再生成

マイグレーションを適用したら、実際の DB から型を再生成する（読み取りのみ）。

```powershell
npm run gen:types      # scripts/supabase/gen-types.mjs → src/types/database.generated.ts
git diff src/types/database.generated.ts
npm run typecheck      # tests/types/database-types.test.ts で絞り込みの崩れも検出する
```

- `gen-types.mjs` は Ref `dnortggovlwgcdeoadbf` 固定。生成に失敗した場合や出力が想定外の場合は既存ファイルを上書きしない。UTF-8・LF で保存する（PowerShell の `>` は使わない）。
- `database.generated.ts` は手で編集しない。CHECK 制約で値が限られる列（category・status など）の絞り込みと、`FaqRow` などの別名は `src/types/database.ts` に書く。
- 列を追加・変更したら、`database.ts` の絞り込み（`Narrowed`）と CHECK 制約の値の型が DB と一致しているか確認する。

### 手順 11：後片付け

```powershell
Remove-Item env:SUPABASE_ACCESS_TOKEN
```

作業用に作ったアクセストークンは、ダッシュボードで削除（Revoke）する。

### 失敗したとき

- 適用中にエラーが出たら、それ以上コマンドを実行せず、エラーメッセージ（キー・パスワードを含まない部分）を記録して報告する。
- `verify.sql` と `migration list` で、どこまで適用されたかを確認する。
- 新規プロジェクトでデータがないため、復旧は「作成されたオブジェクトを手作業で削除して再適用」または「プロジェクトを作り直す」のどちらか。どちらもオーナーと相談してから行う。**`db reset --remote` は使わない。**

## 5. 適用後チェックリスト

### SQL で自動確認（verify.sql・全行 OK で合格）

| 区分 | 確認内容 |
|---|---|
| テーブル | 7 テーブル（admin_users, shop_settings, faqs, menus, line_webhook_events, conversations, broadcasts）がある |
| RLS | 7 テーブルすべてで RLS が有効 |
| ポリシー | テーブルごとの数：admin_users 1、shop_settings 2、faqs 1、menus 1、conversations 2、broadcasts 4、line_webhook_events 0 |
| anon | 全テーブルに権限なし（テーブル単位・列単位とも） |
| authenticated | テーブル単位：faqs・menus は読み書き可、admin_users・shop_settings・conversations は参照のみ、broadcasts は参照・削除、line_webhook_events は権限なし／列単位：shop_settings は id・updated_at を更新不可、conversations は resolved_at・resolved_by のみ更新可、broadcasts は body のみ追加・更新可 |
| service_role | 3 本目のとおりの権限と完全一致（不足も付け過ぎも NG。TRUNCATE・MAINTAIN 等は不可） |
| 関数 | Webhook 用 5 関数・`start_broadcast_sending`・`private.purge_expired_data` は service_role だけが実行可。`private.is_admin()` は authenticated も実行可、anon は不可 |
| search_path | private スキーマと上記 public 関数すべてで固定されている |
| スキーマ | `private` は anon が使用不可、authenticated が使用可 |
| トリガー | updated_at 自動更新 3 つ、`broadcasts_guard` |
| インデックス | 送信中 1 件制限、未対応一覧、停止イベント検出、未通知イベント |
| 2 本目 | line_webhook_events の追加列 8 つ・新しい制約 6 つ・旧制約の削除 |
| 初期データ | shop_settings が 1 行で、`bot_enabled = false` |

`verify.sql` は `tests/db/check-scripts.sql.test.ts` で、正しい DB では全 OK になること、RLS の無効化・anon への権限付与などの改変を NG として検出できることを確認済み。

### 画面で確認

- [x] Integrations → Data API（または API Settings）の公開スキーマに `private` が含まれていない（2026-11-10 `config diff` で確認：`public`, `graphql_public` のみ）
- [x] Advisors → Security Advisor：想定外の警告がない（2026-11-10 `db advisors` で確認：line_webhook_events の「RLS Enabled No Policy」INFO のみ。意図どおり）。Auth 関連の指摘はダッシュボードでも確認する
- [x] Advisors → Performance Advisor：重大な警告がない（未使用インデックスの INFO のみ。新規 DB のため）
- [x] Authentication → Sign In / Providers：一般ユーザーの新規登録を無効にする（管理画面は admin_users に登録した人だけが使える設計だが、不要なアカウント作成を防ぐ）
- [ ] Database → Extensions：pg_cron は**有効にしない**（停止検出・保持期間の削除は Vercel Schedules から行う方式に決定。2026-11-13）

### API 経由の確認（次の作業で実施）

anon キーで次を実行し、いずれも拒否されることを確認する（実際の HTTP 通信を伴うため、承認後に行う）。

- `GET /rest/v1/faqs` → 0 件または権限エラー
- `POST /rest/v1/rpc/claim_line_webhook_event` → 権限エラー
- `POST /rest/v1/line_webhook_events` → 権限エラー

## 6. 環境変数と認証情報の設定

### 取得場所と設定先

| 変数 | 取得場所 | 用途 | 公開してよいか |
|---|---|---|---|
| `SUPABASE_URL` | Project Settings → Data API（または API）の Project URL。値は `https://dnortggovlwgcdeoadbf.supabase.co` | サーバー用の接続先 | 可（ただし不要に公開しない） |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API Keys → Secret keys で作成した **secret key（`sb_secret_…`）** | Webhook など、サーバー処理専用 | **不可。`NEXT_PUBLIC_` を付けない** |
| `WEBHOOK_EVENT_STORE` | — | `supabase` に設定 | — |
| `LINE_REPLY_MODE` | — | `dry-run` のまま（LINE へ送信しない） | — |
| `NEXT_PUBLIC_SUPABASE_URL` | 上の Project URL と同じ値 | 管理画面のログイン（**管理画面の実装まで空でよい**） | 可 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project Settings → API Keys の publishable key（`sb_publishable_…`） | 管理画面のログイン（同上） | 可（RLS で保護） |

#### キーの種類（2026-11-10 調査）

- **サーバー用は新形式の secret key（`sb_secret_…`）を使う。** 変数名 `SUPABASE_SERVICE_ROLE_KEY` は従来のまま、値だけ secret key を入れる。
  - secret key は 1 本ずつ作成・無効化できる。用途ごとに分ける（例：`salon-line-bot-local-dev`、デプロイ時に Vercel 用を別に作る）。
  - legacy の service_role キー（JWT）は、secret key で接続できない場合の予備としてだけ受け付ける（同じプロジェクトのものに限る）。
- `@supabase/supabase-js` 2.119.0 は新形式のキーを識別する。新形式のキーは JWT ではないため、`src/lib/supabase/server.ts` では JWT として解析せず、**`apikey` ヘッダーだけで送る**（SDK が REST で付ける `Authorization: Bearer <キー>` を送信前に取り除く）。Supabase の API ゲートウェイがこの送り方で service_role として扱うことは、実接続（`npm run check:supabase`）で確認する。
- `readSupabaseServerConfig` が起動時に次を拒否する（エラーメッセージにキーの値は含めない）：
  - `https://dnortggovlwgcdeoadbf.supabase.co` 以外の URL（別プロジェクト・http・パス付き・ローカル）
  - publishable key、legacy anon キー、別プロジェクトの legacy キー、形式不明の値、前後の空白や引用符
  - `NEXT_PUBLIC_` で始まる変数に secret key／service_role キーが入っている場合
- DB パスワードと CLI のアクセストークンはアプリでは使わない。`.env.local` にも書かない。

#### ダッシュボードでの取得手順（画面の項目名は変わることがある）

1. https://supabase.com/dashboard/project/dnortggovlwgcdeoadbf を開き、URL の Ref と画面上部のプロジェクト名（salon-line-bot）を確認する。
2. Project Settings → API Keys →「Publishable and secret API keys」→「Secret keys」→ 新しい secret key を作成する（名前：`salon-line-bot-local-dev`）。
3. 表示された値をコピーし、下の手順でメモ帳に直接貼り付ける。
4. 「Legacy API keys」タブでは値を見る必要はない（予備として使う場合だけ確認する）。

### 書き込み方（値を画面・ログ・履歴に残さない）

1. `Copy-Item .env.example .env.local` → `notepad .env.local` でファイルを開く（`.env.local` は `.gitignore` の `.env*` で Git 管理外）。
2. `SUPABASE_URL`・`SUPABASE_SERVICE_ROLE_KEY`・`WEBHOOK_EVENT_STORE=supabase`・`LINE_REPLY_MODE=dry-run` を設定して保存する。ほかの行は空のまま。値の前後に空白や引用符を付けない。
3. **してはいけないこと**：チャット（Claude を含む）に値を貼る、`echo` や `Set-Content` のコマンドに値を書く、スクリーンショットを共有する。
4. ローカルだけの確認（接続しない）：`powershell -ExecutionPolicy Bypass -File scripts\supabase\check-target.ps1` で、URL のホスト、キーの種類（publishable と secret の取り違え）、`NEXT_PUBLIC_` への秘密キー混入、`.env.local` が Git 管理外であることを確認する。新形式のキーには Ref が含まれないため、正しいプロジェクトのキーかどうかは次の 5 で確認する。
5. 読み取り専用の接続確認（承認を得てから実行）：`npm run check:supabase`
   - shop_settings の `id`・`bot_enabled` だけを GET で読む。書き込み・RPC はクライアント側でも送信前に拒否する。キーの値は表示しない。
   - 合格の条件：読み取りに成功（＝このキーでこの Ref のプロジェクトに接続できた）、初期行が 1 行、`bot_enabled = false`。
   - 終了コード 0：合格／1：接続・内容の不合格／2：設定エラー（接続しない）。
   - 不合格の分類：`config`（設定）／`network`（通信）／`timeout`（応答なし）／`auth`（キーが無効・別プロジェクトのキー）／`permission`（GRANT 不足）／`schema`（テーブルなし）／`unexpected_data`（行数・bot_enabled が想定外）／`unknown`。
6. 受信イベントの確認（読み取り専用）：`npm run check:webhook-events -- [--since <分>] [--prefix <ID 接頭辞>] [--limit <件数>] [--sql]`
   - `line_webhook_events` の件数、状態／返信状態の内訳（`simulated` は「dry-run（未送信）」と表示）、直近のイベント一覧を表示する。GET と件数用の HEAD だけを送る。
   - 2 分以上 `processing` のままのイベント、dry-run 設定なのに `sent` のイベント、要通知のイベントがあれば注意を表示する。
   - `--sql` で、表示中のイベントの ID を列挙した確認・削除用 SQL を出力する（実行はしない。SQL Editor で内容を確認してから実行する）。
7. LINE の設定確認：`check-target.ps1` は LINE のチャネルシークレット・アクセストークンの有無と取り違え、`LINE_REPLY_MODE` が dry-run であることも確認する（値は表示しない）。`live` は `-AllowLive` を付けたときだけ OK。
8. 実 DB への書き込みを伴う手動テスト（`npm run test:live-webhook`）は通常のテスト（`npm run test`）とは別設定で、承認を得たときだけ実行する。4 本目の適用が前提。

### その後

- 管理者の登録：Authentication → Users で管理者を招待し、SQL エディタで `insert into public.admin_users (user_id, display_name) values ('<ユーザーの UUID>', '<表示名>');` を実行する（service_role 相当の権限で実行する操作のため、実施時に改めて確認する）。
- Vercel への設定はデプロイ作業時に行う（`SUPABASE_SERVICE_ROLE_KEY` は Production / Preview で別の値にするか検討）。

## 7. 本番プロジェクトの変更記録

| 日付 | 変更 | 実施方法・確認 |
|---|---|---|
| 2026-11-10 | マイグレーション 3 本を適用（initial_schema / webhook_event_processing / grant_service_role） | オーナーが PowerShell で `db push --remote=dnortggovlwgcdeoadbf`。`migration list` で 3 本、`verify.sql` 105 項目すべて OK |
| 2026-11-10 | 認証：一般ユーザーの新規登録を無効化（Allow new users to sign up → OFF） | オーナーがダッシュボードで変更。`config diff` で `auth.enable_signup = false` を確認し、ほかの認証設定に変化がないことも確認 |
| 2026-11-11 | マイグレーション 4 本目を適用（reply_status_simulated） | オーナーが PowerShell で `db push`。`migration list` で 4 本一致、`verify.sql` 106 項目すべて OK、`db advisors` 指摘なし、`gen:types` 差分なし |
| 2026-11-11 | マイグレーション 5 本目を適用（conversation_ai_sources） | オーナーが PowerShell で `db push`。`migration list` で 5 本一致、`verify.sql` 107 項目すべて OK、追加 4 列・4 制約を確認、RLS・権限・ポリシーに変化なし、`db advisors` 指摘なし、`gen:types` で 4 列が生成型に追加 |

### 認証設定の現状（2026-11-10 `config diff` で確認）

| 項目 | 値 | メモ |
|---|---|---|
| 新規登録（enable_signup） | false | 管理者は Authentication → Users から招待する |
| メール確認（email.enable_confirmations） | true | |
| 匿名ログイン | false | |
| 二段階認証（TOTP） | 有効 | |
| パスワードの最低文字数 | 6 | 12 程度への引き上げを推奨（未実施） |
| Site URL | `http://localhost:3000` | 本番公開時に Vercel の URL へ変更する |
| 公開スキーマ | `public`, `graphql_public` | private は非公開 |

ダッシュボードで認証設定を変えたら、この表と変更記録を更新する。
