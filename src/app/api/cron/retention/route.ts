import { createRetentionDepsFromEnv, handleRetentionCron } from "@/lib/retention/cron";

/**
 * 定期実行の受け口：保持期間を過ぎたデータの削除（会話 90 日・Webhook イベント 7 日・利用枠 2 日・通知記録 30 日）。
 *
 * - 呼び出し元：Vercel Schedules（vercel.json の schedules「retention」、1 日 1 回・UTC・パスのターゲット）。
 *   Vercel は GET（requestMethod で指定）で `Authorization: Bearer <CRON_SECRET>` を付けて呼ぶ
 * - CRON_SECRET（32 文字以上）が必須。未設定・短すぎる場合は常に 503 で、DB に接続しない
 * - 8 本目のマイグレーション（20261115000000_retention_purge.sql）が必要。未適用なら 500（何も削除しない）
 * - 何度呼ばれても安全（期限切れの行だけを削除。同時実行は busy）。Vercel は失敗した実行を再試行しない
 */

/** 最大実行時間（秒）。DB 関数の呼び出し 1 回（8 秒で打ち切り）だけなので、既定（300 秒）より短くする */
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  return handleRetentionCron(request, process.env.CRON_SECRET, () => createRetentionDepsFromEnv());
}
