import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * 実 Supabase（Ref: dnortggovlwgcdeoadbf）に書き込む手動テスト専用の設定。
 * 通常の npm run test（tests/**\/*.test.ts）には含まれない。
 * 実行は承認を得たうえで npm run test:live-webhook から行う。
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["scripts/supabase/live/**/*.live.ts"],
    fileParallelism: false,
    // T6 は停止検出のため 2 分以上待つ
    testTimeout: 6 * 60_000,
    // LINE・Claude には接続しない
    env: {
      LINE_CHANNEL_SECRET: "",
      LINE_CHANNEL_ACCESS_TOKEN: "",
      LINE_REPLY_MODE: "dry-run",
      ANTHROPIC_API_KEY: "",
    },
  },
});
