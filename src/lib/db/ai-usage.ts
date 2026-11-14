import { AI_USAGE_LIMITS, isUsageReservation, type UsageReservation, type UsageReservationInput } from "@/lib/ai/usage-limit";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import { DbError } from "./errors";

/**
 * Claude API の利用枠を確認・確保する（public.reserve_ai_usage）。
 * DB エラー・想定外の戻り値は DbError（呼び出し側は AI を呼ばない）。エラーにはコードだけを含める。
 */
export async function reserveAiUsage(
  db: ServerSupabaseClient,
  input: UsageReservationInput,
  limits = AI_USAGE_LIMITS,
): Promise<UsageReservation> {
  const { data, error } = await db.rpc("reserve_ai_usage", {
    p_webhook_event_id: input.webhookEventId,
    p_line_user_id: input.lineUserId,
    p_user_burst_limit: limits.userPer10Minutes,
    p_user_daily_limit: limits.userPerDay,
    p_shop_daily_limit: limits.shopPerDay,
  });
  if (error) throw new DbError("reserveAiUsage", error.code);
  if (!isUsageReservation(data)) throw new DbError("reserveAiUsage", "unexpected_result");
  return data;
}
