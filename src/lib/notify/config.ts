import { SupabaseOwnerNotificationStore } from "@/lib/db/owner-notifications";
import { getShopSettings } from "@/lib/db/shop";
import { createHttpLinePushClient } from "@/lib/line/client";
import { getReplyMode, resolveEventStoreKind } from "@/lib/line/config";
import type { Logger } from "@/lib/line/process-events";
import { createServerSupabaseClient, readSupabaseServerConfig } from "@/lib/supabase/server";
import { createOwnerNotifier, type OwnerNotifier } from "./owner-notifier";

/**
 * オーナー通知の設定（サーバー専用）。
 *
 * - 通知の対象は line_webhook_events に記録されるため、重複判定ストアが supabase のときだけ有効（memory では null）
 * - LINE_REPLY_MODE=live かつ LINE_CHANNEL_ACCESS_TOKEN があるときだけ実際に push する。それ以外は dry-run
 *   （DB にも LINE にも何もしない。対象は未通知のまま残る）
 * - 宛先は shop_settings.owner_line_user_id だけ（環境変数では指定しない。お客様への push を防ぐ）
 * - APP_BASE_URL：通知に載せる未対応一覧のリンク（https のみ。未設定なら載せない）
 */
export function createOwnerNotifierFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  logger: Logger = console,
): OwnerNotifier | null {
  if (resolveEventStoreKind(env) !== "supabase") return null;
  const supabase = readSupabaseServerConfig(env);
  if (!supabase) return null;

  const db = createServerSupabaseClient(supabase);
  const token = env.LINE_CHANNEL_ACCESS_TOKEN ?? "";
  const live = getReplyMode(env) === "live" && token !== "";

  return createOwnerNotifier({
    mode: live ? "live" : "dry-run",
    push: live ? createHttpLinePushClient(token) : null,
    store: new SupabaseOwnerNotificationStore(db),
    loadOwnerId: async () => (await getShopSettings(db)).owner_line_user_id,
    appBaseUrl: env.APP_BASE_URL?.trim() || null,
    logger,
  });
}
