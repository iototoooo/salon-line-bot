import { readClaudeConfig } from "@/lib/ai/claude-model";

/**
 * 管理画面の安全スイッチ（サーバー専用）。**既定はすべて OFF**（ローカル開発中の誤操作で本番 DB・LINE・課金に触れない）。
 *
 * ADMIN_WRITE_MODE=enabled
 *   FAQ・メニュー・店舗情報・自動応答 ON/OFF・通知先・対応済み・配信の下書きなど、DB への書き込みを許可する。
 *   未設定（既定）は閲覧のみ。保存ボタンは押せず、サーバー側でも書き込みを拒否する。
 *
 * LINE_BROADCAST_MODE=live（かつ LINE_CHANNEL_ACCESS_TOKEN あり）
 *   一斉配信のテスト送信（オーナーへの push）と本配信（broadcast）を許可する。送信数（無料枠）を消費する。
 *   未設定（既定）は送信しない。LINE_REPLY_MODE（お客様への返信）とは別のスイッチ。
 *
 * ADMIN_ANSWER_TEST_MODE=live（かつ ANTHROPIC_API_KEY あり）
 *   回答テスト画面で Claude API を呼ぶ（課金が発生する）。未設定（既定）は AI を呼ばず、事前判定の結果だけを表示する。
 */
export type AdminModes = {
  writeEnabled: boolean;
  lineSendEnabled: boolean;
  answerTestAiEnabled: boolean;
};

export function readAdminModes(env: NodeJS.ProcessEnv = process.env): AdminModes {
  return {
    writeEnabled: env.ADMIN_WRITE_MODE === "enabled",
    lineSendEnabled: env.LINE_BROADCAST_MODE === "live" && (env.LINE_CHANNEL_ACCESS_TOKEN ?? "").trim() !== "",
    answerTestAiEnabled: env.ADMIN_ANSWER_TEST_MODE === "live" && readClaudeConfig(env) !== null,
  };
}

export const WRITE_DISABLED_MESSAGE =
  "書き込みは無効になっています（安全のための初期設定）。保存するには、サーバーの環境変数 ADMIN_WRITE_MODE=enabled が必要です。";

export const LINE_SEND_DISABLED_MESSAGE =
  "LINE への送信は無効になっています（安全のための初期設定）。送信するには、サーバーの環境変数 LINE_BROADCAST_MODE=live が必要です。";
