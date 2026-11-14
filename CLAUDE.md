@AGENTS.md

# salon-line-bot

## 回答の言語（必ず守る）

- 作業報告・説明・確認事項・質問は、**すべて日本語**で回答する。英語の回答は不要。
- コード、コマンド、ファイル名、変数名、エラーメッセージの引用などは英語のままでよい。

美容室向け LINE bot＋AI自動応答システム（AI開発講座 初級編・案件1／模擬受託案件）。
LINE の問い合わせに、登録済みの FAQ・メニュー・店舗情報だけを根拠に Claude が回答し、回答できない質問はオーナーへ通知する。管理画面から FAQ・料金の更新とお知らせの一斉配信を行う。

## 設計資料（実装前に必ず参照）

- `docs/requirements.md`：要件定義（スコープ・機能要件・受け入れ基準 AC-xx）
- `docs/architecture.md`：構成・データフロー・DB設計・プロンプト設計・誤回答/誤送信対策
- `docs/proposal.md`：クライアント向け提案書（費用・期間）
- `docs/wbs.md`：作業計画（WBS ID ごとの完了条件）
- `docs/manual.md`：オーナー向けの運用マニュアル（画面の操作・トラブル時の対応）。画面の文言を変えたら合わせて更新する
- `docs/deployment.md`：Vercel へのデプロイ手順（Hobby・定期実行の Schedules・`CRON_SECRET` の作成と登録・環境変数・Webhook URL の切り替え・初回デプロイの安全な順序）。本番へのデプロイは承認後のみ
- `docs/handover.md`：引き継ぎ資料（アカウント一覧・環境変数一覧・運用・障害時の停止方法・既知の制約）。秘密情報の値は書かない
- `docs/line-device-test.md`：LINE 実機テスト（AC-07・AC-23・AC-24）の手順。実施は承認後のみ
- `scripts/supabase/sample-data/sample-salon.sql`：学習用の架空の美容室の初期データ（本番への登録は承認後のみ。自動応答・通知先は変更しない）
- `docs/supabase-setup.md`：Supabase（Ref `dnortggovlwgcdeoadbf`）へのマイグレーション適用手順。確認用 SQL・スクリプトは `scripts/supabase/`（preflight.sql／verify.sql は読み取り専用、check-target.ps1 は接続先の確認）。リモートへの操作は必ず `--workdir` と `--remote=<Ref>` を明示し、`supabase login`・`db reset` は使わない

docs/ の設計資料は削除・全面上書きしない。仕様変更が必要な場合は、該当箇所だけを更新し、その旨を報告する。

## 技術スタック

- Next.js（App Router, `src/` ディレクトリ）＋ TypeScript ＋ Tailwind CSS v4
- Supabase（PostgreSQL + Auth）／ Claude API ／ LINE Messaging API ／ Vercel
- この Next.js はバージョンが新しく、学習データと API が異なる可能性がある。コードを書く前に `node_modules/next/dist/docs/` の該当ガイドを確認する（AGENTS.md 参照）。

## コマンド

```bash
npm run dev        # ローカル起動 http://localhost:3000
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
npm run build      # 本番ビルド
npm run test       # Vitest（tests/**/*.test.ts、外部APIはすべてモック）
npm run check:supabase        # 実 Supabase への読み取り専用の接続確認（承認後）
npm run check:webhook-events  # line_webhook_events の読み取り専用レポート（--since / --prefix / --sql）
npm run test:live-webhook     # 実 DB に書き込む手動テスト（vitest.live.config.mts。承認時のみ）
npm run test:e2e   # 管理画面のブラウザ自動テスト（Playwright・Edge）。本番には接続しない（下記）
```

変更後は `test` → `lint` → `typecheck` → `build` の順で確認してから完了報告する。

## Webhook の実装方針（src/lib/line）

LINE 仕様：replyToken は原則 1 回のみ・受信後 1 分以内／2xx 応答後の失敗は LINE の再送では回復しない／テキストは最大 5,000 文字／重複は webhookEventId で検出。

- `webhook-handler.ts`：署名検証（生バイト列）→ JSON 検証 → `claimEvents` で受付を記録（失敗なら 500）→ 200 → `after()` で処理
- `process-events.ts`：返信直前に `store.beginReply`（未使用・期限内のみ許可）→ 返信 → `sent` / `failed`（4xx）/ `unknown`（5xx・タイムアウト）を記録。同じトークンで再送しない
- `event-store.ts`：インターフェースとインメモリ実装（開発・テスト専用）。`supabase-event-store.ts`：`line_webhook_events` の DB 関数を呼ぶ本番用実装
- `config.ts`：`WEBHOOK_EVENT_STORE` でストアを切り替え（本番 `VERCEL_ENV=production` でメモリ実装はエラー）。`LINE_REPLY_MODE=live` を明示しない限り LINE へ送信しない。dry-run の返信は `reply_status = simulated`（送信成功の `sent` と区別）
- 返信内容は `Responder` で差し替える（`src/lib/bot/config.ts`、`LINE_RESPONDER=echo|ai`、未設定は echo・本番では ai 必須）。Responder は配列（Echo）か `ResponderResult`（返信後の会話ログ保存 `afterReply`・要通知）を返す
- AI 応答（`src/lib/ai/`・`src/lib/bot/ai-responder.ts`）：bot_enabled=false なら AI を呼ばず `fallback_message` のみ。参照データは `<reference_data>` で囲み `< >` を全角化。出力は JSON スキーマで受け取り `guard.ts` で根拠 ID・金額・予約可否の断定・電話番号・URL を検証し、不合格は「確認が必要です」＋要オーナー対応。予約の返信は AI の文章を使わずコードで組み立てる。テストは `AnswerModel` のモック（実 API は呼ばない）
- 利用回数制限（`src/lib/ai/usage-limit.ts`・`src/lib/db/ai-usage.ts`・DB 関数 `reserve_ai_usage`）：`generateAnswer` の `reserveUsage` は必須で、AI 呼び出しの直前に利用枠を確保し `reserved` のときだけ AI を呼ぶ。例外・上限到達は AI を呼ばず `USAGE_LIMIT_MESSAGE`。回数の上限であり金額の上限ではない
- オーナー通知（`src/lib/notify/`・`src/lib/db/owner-notifications.ts`・DB 関数 `claim_owner_notification_batch` / `finish_owner_notification_batch`、7 本目）：対象は `line_webhook_events` の要通知・未通知のイベント。`processEvents` が全イベントの返信後に `notifyOwner` を 1 回呼び、DB でまとめを確保（10 分間隔・1 日 5 通・店舗全体の利用上限だけ 1 日 1 回即時）して `owner_line_user_id` にだけ push（`X-Line-Retry-Key`、成否不明は同じキーで再送）。通知の失敗は返信に影響させない。dry-run では DB にも LINE にも何もしない。宛先が未設定なら送らず未通知のまま残す。定期実行は `/api/cron/owner-notify`（`CRON_SECRET` 必須・`maxDuration` 60 秒）を `vercel.json` の Vercel Schedules で 15 分ごと（Hobby（無料）で使える最短。Cron Jobs は Hobby では 1 日 1 回までのため使わない）。導入手順は `docs/deployment.md`
- 保持期間の削除（`src/lib/retention/cron.ts`・`src/lib/db/retention.ts`・DB 関数 `run_retention_purge`、8 本目・2026-11-13 本番適用済み・定期実行は未デプロイ）：`/api/cron/retention`（`CRON_SECRET` 必須）を Vercel Schedules で 1 日 1 回（18:17 UTC）。会話 90 日・Webhook イベント 7 日・利用枠 2 日・通知記録 30 日。保持期間は DB 関数内で固定（引数なし）。同時実行は busy。管理者・店舗情報・FAQ・メニュー・配信は削除しない。定期実行のルートは GET だけを公開し、`vercel.json` で `requestMethod: "GET"` を指定する
- 管理画面（`src/app/admin/`・`src/app/login/`・`src/lib/admin/`・`src/proxy.ts`）：Supabase Auth（`@supabase/ssr`）でログインし、データ操作は publishable key＋セッション（RLS 適用）で行う。ページ・Server Action の先頭で必ず `requireAdmin()`。本体のロジックは `src/lib/admin/*-actions.ts`（Next.js に依存しない・テスト対象）。安全スイッチ `ADMIN_WRITE_MODE`・`LINE_BROADCAST_MODE`・`ADMIN_ANSWER_TEST_MODE` は既定 OFF。詳細は `docs/architecture.md` 7.4
- `src/lib/supabase/server.ts`：service_role の Supabase クライアント（サーバー専用）。`src/lib/db/`：テーブルごとのアクセス関数。型は `src/types/database.generated.ts`（`npm run gen:types` で実 DB から生成。手で編集しない）を基本に、`src/types/database.ts` で CHECK 制約の値の絞り込みと別名（FaqRow など）を定義する。マイグレーション適用後は再生成する。`supabase config push` は実行しない（ローカルの config.toml は本番より緩い既定値）
- テスト：`tests/db/` は PGlite（ローカルの PostgreSQL）に全マイグレーションを適用して検証する。実 Supabase には接続しない
- ブラウザ自動テスト（`e2e/`・`playwright.config.ts`）：Next.js を `NODE_ENV=test` で起動するため `.env.local` は読み込まれない。接続先は `e2e/fake-supabase.mjs`（PGlite＋REST・Auth の最小限の再現。127.0.0.1 のみ）で、RLS は本番と同じく効く。`e2e/network-guard.mjs` がサーバーの通信先をローカルに限定する。偽の接続先を許可するのは `NODE_ENV=test` のときだけ（`readE2eFakeSupabaseUrl`）。既存のサーバーは再利用しない

## 実装ルール（必ず守る）

1. **AI に予約状況を推測させない。** 空き状況・予約可否・予約確定は回答させず、予約方法の案内のみ。プロンプトだけに頼らず、コード側の出力チェックで断定表現を検出し定型文に差し替える。
2. **回答の根拠は DB の FAQ・menus・shop_settings のみ。** 料金は DB の値をそのまま使い、AI に計算させない。出力中の金額は menus と照合する。
3. **回答不能・エラー時も無応答にしない。** 定型文を返し、オーナーへ通知し、conversations に記録する。
4. **LINE 署名検証は必須。** 検証前のボディを信用しない。`webhookEventId` で重複処理を防ぐ。
5. **一斉配信は誤送信防止を省略しない。** テスト送信必須・送信可能数の確認・確認文言入力・二重送信防止（status の条件付き更新＋`X-Line-Retry-Key`）。
6. **push の宛先はオーナーのみ。** お客様への送信は replyToken への reply か、確認済みの broadcast だけ。
7. **秘密情報をコードやリポジトリに含めない。** 環境変数は `.env.local`（Git 管理外）。`.env.example` は空の値のみ。`SUPABASE_SERVICE_ROLE_KEY` などをクライアントコンポーネントで参照しない。
8. **Supabase の全テーブルで RLS を有効化**する。スキーマ変更は `supabase/migrations/` の SQL で管理する。
9. 不要なパッケージを追加しない。追加する場合は理由を説明する。

## 外部サービスに関する禁止事項（ユーザーの明示的な指示があるまで行わない）

- Supabase プロジェクトの作成・変更（既存プロジェクトには一切触れない）
- LINE Developers / LINE 公式アカウントの設定変更、本番アカウントへの送信
- Claude API の実呼び出し（課金が発生する）
- GitHub への push、Vercel へのデプロイ
- 実際の API キーを環境変数ファイルに書き込むこと

各サービスの料金・無料枠・規約は未確認のものがある（docs/architecture.md「8. 費用に関わる設計上の前提」）。確認していない値を事実として扱わない。

## 作業範囲

作業はこのリポジトリのフォルダ内に限定する。ほかのプロジェクトには変更を加えない。
