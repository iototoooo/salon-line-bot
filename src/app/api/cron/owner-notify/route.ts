import { createWebhookEventStore, resolveEventStoreKind } from "@/lib/line/config";
import { createOwnerNotifierFromEnv } from "@/lib/notify/config";
import { handleOwnerNotifyCron } from "@/lib/notify/cron";

/**
 * 定期実行の受け口：停止イベントの検出とオーナー通知のまとめ送信。
 *
 * - 呼び出し元：Vercel Schedules（vercel.json の schedules「owner-notify」、15 分ごと・UTC・パスのターゲット）。
 *   Hobby（無料）で使える最短の間隔。Vercel は GET（requestMethod で指定）で `Authorization: Bearer <CRON_SECRET>` を付けて呼ぶ
 * - CRON_SECRET（32 文字以上）が必須。未設定・短すぎる場合は常に 503 で、DB にも LINE にも接続しない
 * - リクエストヘッダーを読むため、毎回実行される（キャッシュされない。Cache Components 有効時は `dynamic` は使えない）
 * - 何度呼ばれても安全（まとめの確保は DB のロック、成否不明の再送は同じ再送キー）。Vercel は失敗した実行を再試行しない
 */

/**
 * 最大実行時間（秒）。通常は DB 呼び出し数回（各 8 秒で打ち切り）と LINE への push（10 秒で打ち切り）で 15 秒程度。
 * 異常時に長く動き続けないよう、Vercel の既定（300 秒）より短くする（Hobby・Pro とも設定可能な範囲内）
 */
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  return handleOwnerNotifyCron(request, process.env.CRON_SECRET, () => ({
    // 停止イベントは DB に記録されるものだけが対象（memory ストアでは扱わない）
    store: resolveEventStoreKind() === "supabase" ? createWebhookEventStore() : null,
    notifier: createOwnerNotifierFromEnv(),
    logger: console,
  }));
}
