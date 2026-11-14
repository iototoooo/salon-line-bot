# 引き継ぎ資料（WBS 5.4）

- 対象：美容室向け LINE bot＋AI 自動応答システム（AI 開発講座 初級編・案件 1／学習用の模擬受託案件）
- 版数：v0.2（2026-11-13 作成。2026-11-14 に学習用の作品として完成とし、現状と今後の発展課題を更新）
- **位置づけ：開発学習用の作品として 2026-11-14 に完成。実際の店舗では運用しない**（詳細は [wbs.md](./wbs.md) 6.8）
- 読む人：保守担当者（技術者）。オーナー向けの操作説明は [manual.md](./manual.md)
- **この資料には秘密情報の値（キー・パスワード・トークン・LINE ユーザー ID）を書かない。** 値はクライアントのパスワード管理ツールで管理する

関連資料：要件 [requirements.md](./requirements.md)／設計 [architecture.md](./architecture.md)／デプロイ [deployment.md](./deployment.md)／DB [supabase-setup.md](./supabase-setup.md)／実機テスト [line-device-test.md](./line-device-test.md)／作業計画 [wbs.md](./wbs.md)

---

## 1. 現在の状態（2026-11-14）

| 項目 | 状態 |
|---|---|
| ソースコード | ローカルの Git（`main`）にコミット済み。**GitHub へは未 push** |
| データベース（Supabase） | マイグレーション 8 本を本番へ適用済み。`verify.sql` 136 項目すべて OK |
| 管理者 | Auth ユーザー 1 人・`admin_users` 1 人。新規登録（サインアップ）は無効 |
| 自動応答 | **OFF**（`shop_settings.bot_enabled = false`）。初期データは学習用の架空店舗「ヘアサロン こもれびの森」を 2026-11-14 に登録済み（FAQ 12 件・メニュー 10 件。`scripts/supabase/sample-data/sample-salon.sql`、取り消しは `sample-salon.rollback.sql`） |
| オーナー通知の宛先 | 登録済み（値はここに書かない） |
| Vercel | **本番デプロイ済み**（Hobby・https://salon-line-bot-nine.vercel.app・関数は東京 hnd1）。環境変数 11 項目（返信は dry-run・安全スイッチと AI のキーは未登録）。定期通知・定期削除は有効。手順は [deployment.md](./deployment.md) 9〜11 章 |
| LINE | Webhook URL は本番に切り替え済み。2026-11-14 に実機テスト（AC-07・AC-23・AC-24）を実施（[line-device-test.md](./line-device-test.md) 5 章）。今月の使用 4 通（無料枠 200 通） |
| Claude API | **無効**（`ANTHROPIC_API_KEY` 未登録）。2026-11-14 に管理画面の回答テストで実接続テストを行い、主要 5 問に合格。テスト後に API キーと `ADMIN_ANSWER_TEST_MODE` を削除して再デプロイ済み（[wbs.md](./wbs.md) 6.10）。LINE 経由の AI 自動返信は未検証 |

## 2. アカウント一覧

いずれも**クライアント（店舗）名義**で作成し、保守担当者は招待されたメンバーとして操作する。ログイン情報はクライアントのパスワード管理ツールに保存する。

| サービス | 用途 | 名前・識別子 | プラン | 保守担当者の権限 | 備考 |
|---|---|---|---|---|---|
| Supabase | DB（PostgreSQL）・管理画面のログイン（Auth） | プロジェクト `salon-line-bot`／Ref `dnortggovlwgcdeoadbf`／Tokyo（ap-northeast-1） | Free | 組織のメンバー | 1 週間アクセスがないと一時停止する（再開はダッシュボードから）。同じ組織にほかのプロジェクトがあるため、**操作のたびに Ref を確認する** |
| Vercel | ホスティング・定期実行（Schedules） | プロジェクト名は作成時に決める | Hobby（無料・非商用に限る） | プロジェクトのメンバー | 学習課題のため Hobby。商用で運用する場合は Pro が必要 |
| LINE Developers | Messaging API のチャネル（Webhook・返信・配信） | プロバイダー・チャネル名は作成時の値 | — | チャネルの管理者 | チャネルシークレット・アクセストークンを発行する場所 |
| LINE 公式アカウント | お客様とのトーク・メッセージ通数 | 店舗の公式アカウント | コミュニケーションプラン（無料。月 200 通） | 管理者 | 応答設定（Webhook・自動応答メッセージ）の場所。オーナーはここで配信履歴を確認できる |
| Anthropic（Claude API） | AI 応答 | Console の組織・API キー | 従量課金 | メンバー | **利用上限額の設定が必要**（WBS 5.2）。キーは用途ごとに分けて発行する |
| GitHub（任意） | ソースコードの保管 | 未作成 | — | — | push は承認後 |

管理画面のログインアカウント（Supabase Auth）：

- 追加：Supabase の Authentication → Users で作成し、`public.admin_users` に `user_id` を登録する（SQL Editor。本番への書き込みのため承認後）
- 削除：`admin_users` の行を削除 → Auth ユーザーを削除（会話の「対応者」は空欄になる）
- パスワードの再設定：Authentication → Users から再設定メールを送る（メール送信の設定は**要確認**）

## 3. 環境変数一覧

値はここに書かない。Vercel では **Production 環境にだけ**設定する（Preview・Development には設定しない）。秘密の値は **Sensitive** にする。

| 変数 | 区分 | 本番の値（設定の目安） | 未設定・既定のときの動き |
|---|---|---|---|
| `LINE_CHANNEL_SECRET` | 秘密 | LINE Developers の「チャネルシークレット」 | 署名を検証できず、すべての Webhook を 401 で拒否 |
| `LINE_CHANNEL_ACCESS_TOKEN` | 秘密 | 長期のチャネルアクセストークン | 返信・通知・配信ができない |
| `LINE_REPLY_MODE` | 安全スイッチ | 実機テストの承認までは `dry-run`、運用開始時に `live` | `dry-run`：お客様へ返信しない（記録は `simulated`） |
| `LINE_RESPONDER` | 設定 | `ai` | 本番では未設定・`echo` はエラー（返信せず 500） |
| `ANTHROPIC_API_KEY` | 秘密 | 本番用のキー | 空なら AI を呼ばず「確認が必要です」＋要オーナー対応 |
| `CLAUDE_MODEL` | 設定 | 空欄（既定 `claude-haiku-5-5`） | 既定のモデル |
| `NEXT_PUBLIC_SUPABASE_URL` | 公開可 | `https://dnortggovlwgcdeoadbf.supabase.co` | 管理画面にログインできない。**ビルド時に埋め込まれる**ため、変更したら再デプロイ |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 公開可 | publishable key（`sb_publishable_…`） | 同上。secret key を入れると起動時にエラー |
| `SUPABASE_URL` | 設定 | `https://dnortggovlwgcdeoadbf.supabase.co` | 空なら `NEXT_PUBLIC_SUPABASE_URL` を使う。ほかの Ref はエラー |
| `SUPABASE_SERVICE_ROLE_KEY` | 秘密（最重要） | secret key（`sb_secret_…`） | Webhook・通知・定期実行が DB に接続できない（本番ではエラーで止まる） |
| `WEBHOOK_EVENT_STORE` | 設定 | `supabase` | 接続情報があれば `supabase`。本番で `memory` はエラー |
| `APP_BASE_URL` | 設定 | `https://<本番のドメイン>`（末尾の `/` なし） | 通知に管理画面のリンクが載らない |
| `CRON_SECRET` | 秘密 | 32 文字以上の英数字（作り方は deployment.md 3 章） | 定期実行（通知・削除）が 503 で何もしない |
| `ADMIN_WRITE_MODE` | 安全スイッチ | 運用時は `enabled` | 管理画面は閲覧のみ |
| `LINE_BROADCAST_MODE` | 安全スイッチ | 配信を使うときだけ `live` | テスト送信・配信をしない |
| `ADMIN_ANSWER_TEST_MODE` | 安全スイッチ | 通常は空。AI の回答を試すときだけ `live` | 回答テストで AI を呼ばない（課金なし） |

ローカル開発では `.env.local`（Git 管理外）に設定する。ひな形は `.env.example`（値は空）。

## 4. 運用方法

### 毎日・随時（オーナー）

- 未対応一覧の確認と対応（オーナー通知のリンクから開ける）。操作は [manual.md](./manual.md) 6 章
- FAQ・メニュー・店舗情報の更新（manual.md 3〜5 章）

### 自動で行われる処理

| 処理 | いつ | どこで確認するか |
|---|---|---|
| オーナー通知のまとめ送信・停止したイベントの検出 | Webhook の受信時と、15 分ごと（Vercel Schedules「owner-notify」） | Vercel の Schedules の実行履歴（`200` が正常、`500` は失敗）、`owner_notification_batches` |
| 保持期間を過ぎたデータの削除（会話 90 日・Webhook 記録 7 日・利用枠 2 日・通知記録 30 日） | 毎日 日本時間 3:17 ごろ（「retention」） | 実行履歴とログ `[cron:retention] purged {...件数}` |
| AI の利用回数の制限（1 人 10 分 5 回・1 日 30 回、店舗 1 日 300 回） | 毎回 | 上限に達すると定型文を返し、店舗全体の上限は 1 日 1 回すぐ通知 |

### 毎月（保守担当者）

1. LINE 公式アカウントのメッセージ通数（無料 200 通のうちの使用数）。オーナー通知・テスト送信・配信が使う（返信は数えられない扱いだが**要確認**）
2. Anthropic Console の利用額と上限額
3. Vercel の Usage と Schedules の実行履歴（月 5,000 回の上限。通常は約 3,000 回）
4. Supabase の使用量（Free の上限）と、1 週間無操作による一時停止がないか
5. 停止イベント・返信の失敗：`npm run check:webhook-events -- --since <日付>`（読み取り専用・本文や ID は表示しない）
6. `verify.sql`（読み取り専用）で権限・RLS が変わっていないこと

### 変更を加えるとき

- 手順：変更 → `npm run test` → `lint` → `typecheck` → `build` →（管理画面の変更なら）`npm run test:e2e` → コミット → 承認後に push・デプロイ
- DB の変更は `supabase/migrations/` に新しいファイルを追加し、[supabase-setup.md](./supabase-setup.md) の手順（preflight → dry-run → 承認 → 適用 → verify → 型の再生成）で行う。`db reset`・`supabase login`・`config push`・`--yes` は使わない
- 画面の文言を変えたら manual.md も直す

## 5. 障害時の停止方法

影響の小さい順。上から試す。

| 止めたいもの | 方法 | 所要時間 | 影響 |
|---|---|---|---|
| **AI の自動応答**（誤回答など） | 管理画面「店舗情報・設定」→ 自動応答を OFF（確認の欄に「変更する」） | すぐ | お客様には定型文が返り、未対応一覧に記録される。**最優先の操作** |
| 管理画面が使えないときの AI 停止 | Supabase の SQL Editor（Ref を確認）で `update public.shop_settings set bot_enabled = false where id = 1;` | 数分 | 同上（本番への書き込み） |
| AI の課金 | Anthropic Console で API キーを無効化、または利用上限額を下げる | 数分 | AI を呼べず、定型文＋要オーナー対応になる（エラーにはならない） |
| お客様への返信をすべて止める | Vercel の環境変数 `LINE_REPLY_MODE` を `dry-run` にして再デプロイ | 数分 | 返信しない（受信の記録は続く）。お客様には何も届かないため、長くは続けない |
| 一斉配信 | `LINE_BROADCAST_MODE` を削除して再デプロイ | 数分 | テスト送信・配信ができなくなる |
| 管理画面からの書き込み | `ADMIN_WRITE_MODE` を削除して再デプロイ | 数分 | 閲覧のみになる |
| 定期実行（通知・削除） | Vercel → Schedules で該当のスケジュールを **Disable**（再デプロイ不要） | すぐ | 通知は Webhook 受信時には送られる。削除は止まり、再開後にまとめて実行 |
| LINE からの受信そのもの | LINE Developers → Messaging API → 「Webhook の利用」を OFF | すぐ | Webhook が届かない（お客様のメッセージはトークには残る。LINE 公式アカウント側の応答設定に従う） |
| 新しいデプロイの不具合 | Vercel → Deployments → 直前の正常なデプロイを **Instant Rollback** | すぐ | 環境変数・Schedules の設定も戻る |
| 秘密情報の漏えいが疑われる | 該当のキーを発行元で再発行（失効）→ Vercel の値を更新 → 再デプロイ。Supabase の secret key は API Keys で新しいキーを作ってから古いキーを削除 | 数十分 | 再発行の間は該当の機能が止まる |

障害の記録：発生日時・現象・行った操作・再開の判断をメモに残し、オーナーに報告する。お客様への個別の連絡が必要かはオーナーが判断する。

## 6. 既知の制約

### 無料プランの制約（学習課題のため有料化しない。2026-11-13 決定）

| 制約 | 内容 | 影響と対応 |
|---|---|---|
| **Supabase Auth の Leaked Password Protection（漏えいパスワードの検出）が使えない** | Pro 以上の機能（2026-11-13 に確認）。`db advisors` に WARN が 1 件出続ける | 管理者のパスワードは長く推測しにくいものにし、使い回さない。管理者は 1 人・新規登録は無効。商用で運用する場合は Pro で有効にする |
| Supabase Free の一時停止 | 1 週間アクセスがないと一時停止する | Webhook・定期実行が DB に接続できず失敗する。毎日の削除の実行があるため通常は止まらない見込みだが**要確認**。停止したらダッシュボードから再開 |
| Vercel Hobby | 非商用・個人利用のみ。Schedules は最短 15 分・15 分の幅でずれる・月 5,000 回まで（ベータ） | 通知の遅れは最大 30 分程度。商用は Pro が必要 |
| LINE 無料プラン | メッセージは月 200 通まで（オーナー通知・テスト送信・配信が対象） | 配信は残り通数が足りないと画面で止まる。通知は 1 日 5 通まで |
| バックアップ | Supabase Free の自動バックアップの内容・保持期間は**未確認** | FAQ・メニューは管理画面から書き出す機能がない。大きな変更の前に SQL Editor で内容を控える |

### 仕様上の制約

- AI は登録された FAQ・メニュー・店舗情報だけを根拠に答える。空き状況・予約の可否・予約の確定には答えない（予約の案内だけ）
- 料金は DB の値をそのまま答える（AI に計算させない）。出力の金額・電話番号・URL は登録内容と照合し、合わなければ「確認が必要です」＋要オーナー対応
- 画像・スタンプなどには定型文を返す
- 会話ログは 90 日で削除される（未対応のものも含む）
- 一斉配信は友だち全員だけ（属性での絞り込みはない）。テキストのみ
- お客様への送信は返信（reply）と確認済みの配信だけ。push はオーナーにだけ送る

### 未実施・今後の発展課題（2026-11-14 に学習用として完成。以下は実施しない）

- 完了済み（2026-11-14）：Vercel へのデプロイ・LINE Webhook の切り替え・定期実行の有効化、実機テスト AC-07・AC-23・AC-24、学習用の初期データの登録、AC-22（開発者本人がオーナー役）
- **実施済み（2026-11-14）**：Claude API の実接続テスト（管理画面の回答テスト経由で主要 5 問 AC-01〜05 に合格）。テスト後は安全設定に復旧（API キー・`ADMIN_ANSWER_TEST_MODE` を削除して再デプロイ）
- **未検証**：LINE 経由の AI 自動返信（API キーの再登録・自動応答 ON・返信 live が必要）、AI を使う残りの受け入れテスト（AC-06 の AI 経路・08・10・12）
- **未実施**：定期削除の最初の実行（11/15 03:17 JST ごろ）の確認（`npx vercel@65.15.0 schedules executions list retention --since 1d`）
- 本番の定期実行（通知・削除）は有効のまま。運用しない間も定期削除は保持期間を過ぎたデータを削除する。止める場合は Vercel の Schedules で Disable、または Settings → General で Pause Project
- AC-22 は 2026-11-14 に**開発者本人がオーナー役**として確認済み（wbs.md 6.7）。引き継ぎのときに、実際の美容室オーナーにマニュアル 3 章を見ながら非公開 FAQ の追加・削除を 1 回してもらうことを推奨（`ADMIN_WRITE_MODE` を一時的に有効にし、終わったら削除して再デプロイ。前後で `content-fingerprint.sql` を比べる）
- 開発用パッケージ（ESLint 関連）の更新（npm audit の中程度 7 件。本番の依存は 0 件）
