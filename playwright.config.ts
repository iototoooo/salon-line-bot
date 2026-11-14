import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "@playwright/test";

/**
 * 管理画面のブラウザ自動テスト（npm run test:e2e）。
 *
 * 本番から切り離すための仕組み
 * - Next.js を NODE_ENV=test で起動する → .env.local（本番の認証情報）は読み込まれない（Next.js の仕様）
 * - 接続先は e2e/fake-supabase.mjs（PGlite のメモリ上の DB。127.0.0.1 だけで待ち受け）。テスト用のダミーキーだけを使う
 * - e2e/network-guard.mjs で、テスト用サーバーの通信先を 127.0.0.1 / localhost に限定する（本番 Supabase・LINE・Claude へは接続不可）
 * - LINE のトークン・Claude の API キー・サーバー用の秘密キーは空にする。LINE 送信・AI 回答テストの安全スイッチは OFF
 * - 既存のサーバーは再利用しない（.env.local で起動中のサーバーに誤って接続しない）
 * - ブラウザはインストール済みの Microsoft Edge を使う（ブラウザのダウンロードは不要）
 */
const FAKE_PORT = 54329;
const APP_PORT = 3100;
const FAKE_URL = `http://127.0.0.1:${FAKE_PORT}`;
const guard = pathToFileURL(join(__dirname, "e2e", "network-guard.mjs")).href;

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts$/,
  // README 用の画面キャプチャ（e2e/screenshots.spec.ts）は、CAPTURE_SCREENSHOTS=1 のときだけ実行する
  testIgnore: process.env.CAPTURE_SCREENSHOTS === "1" ? [] : [/screenshots\.spec\.ts$/],
  // テストはメモリ上の 1 つの DB を共有するため、1 件ずつ順番に実行する（各テストの前に DB を初期化する）
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    channel: "msedge",
    headless: true,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    {
      command: "node e2e/fake-supabase.mjs",
      url: `${FAKE_URL}/__e2e/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { E2E_FAKE_SUPABASE_PORT: String(FAKE_PORT) },
    },
    {
      command: `node node_modules/next/dist/bin/next dev -p ${APP_PORT} -H 127.0.0.1`,
      url: `http://127.0.0.1:${APP_PORT}/login`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        NODE_ENV: "test",
        NODE_OPTIONS: `--import=${guard}`,
        NEXT_TELEMETRY_DISABLED: "1",
        // 偽の Supabase（テスト専用のダミーキー）
        E2E_FAKE_SUPABASE_URL: FAKE_URL,
        NEXT_PUBLIC_SUPABASE_URL: FAKE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_E2E_dummy_key_for_local_tests",
        // サーバー用の秘密キー・外部サービスの認証情報は使わない
        SUPABASE_URL: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
        LINE_CHANNEL_SECRET: "",
        LINE_CHANNEL_ACCESS_TOKEN: "",
        ANTHROPIC_API_KEY: "",
        CRON_SECRET: "",
        // 安全スイッチ：保存だけ許可（偽の DB への書き込み）。LINE 送信・AI 呼び出しは OFF
        ADMIN_WRITE_MODE: "enabled",
        LINE_BROADCAST_MODE: "",
        ADMIN_ANSWER_TEST_MODE: "",
        LINE_REPLY_MODE: "dry-run",
        LINE_RESPONDER: "",
        WEBHOOK_EVENT_STORE: "memory",
      },
    },
  ],
});
