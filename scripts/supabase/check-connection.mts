// Supabase への読み取り専用の接続確認。npm run check:supabase で実行する。
//
// - .env.local の SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY（secret key）を使う
//   （シェルの環境変数が設定されている場合はそちらが優先される）
// - shop_settings の id と bot_enabled だけを読む。書き込み・RPC は行わない（クライアント側でも拒否）
// - キーの値は表示しない
// - 終了コード 0: 合格 / 1: 接続・内容の不合格 / 2: 設定エラー
//
// Node 24 の TypeScript 型除去機能で直接実行する（追加パッケージなし）。
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runConnectionCheck } from "../../src/lib/supabase/connection-check.ts";
import { createServerSupabaseClient, readSupabaseServerConfig } from "../../src/lib/supabase/server.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const envFile = join(root, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

process.exitCode = await runConnectionCheck(process.env, {
  readConfig: readSupabaseServerConfig,
  createClient: createServerSupabaseClient,
  log: (line) => console.log(line),
});
