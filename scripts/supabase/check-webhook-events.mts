// line_webhook_events を読み取り専用で確認する。npm run check:webhook-events -- [オプション]
//
//   --since <分>      受信が直近 N 分のイベントだけ（既定 60）
//   --prefix <文字列> イベント ID の接頭辞で絞り込む（英数字とハイフンのみ）
//   --limit <件数>    一覧の表示件数（既定 30）
//   --sql             対象イベントの確認・削除用 SQL を表示する（実行はしない）
//
// - .env.local の SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を使う（シェルの環境変数が優先）
// - GET（と件数用の HEAD）だけを送る。書き込み・RPC はクライアント側でも拒否する
// - キーの値は表示しない
// - 終了コード 0: 成功 / 1: 読み取り失敗 / 2: 設定・引数エラー
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServerSupabaseClient, readSupabaseServerConfig } from "../../src/lib/supabase/server.ts";
import { runWebhookEventsReport } from "../../src/lib/supabase/webhook-events-report.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const envFile = join(root, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

process.exitCode = await runWebhookEventsReport(process.env, process.argv.slice(2), {
  readConfig: readSupabaseServerConfig,
  createClient: createServerSupabaseClient,
  log: (line) => console.log(line),
});
