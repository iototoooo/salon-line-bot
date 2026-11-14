import { vi } from "vitest";
import { AI_USAGE_LIMITS, type AiUsageLimiter, type UsageReservation, type UsageReservationInput } from "@/lib/ai/usage-limit";

/**
 * テスト用の利用回数制限（DB 関数 reserve_ai_usage と同じ判定をメモリ上で行う）。
 * 実際の DB の判定・同時実行は tests/db/ai-usage.sql.test.ts（PGlite）で検証する。
 */
export function memoryUsageLimiter(limits: { userPer10Minutes: number; userPerDay: number; shopPerDay: number } = AI_USAGE_LIMITS) {
  const records: Array<{ id: string; user: string }> = [];
  const reserve = vi.fn(async (input: UsageReservationInput): Promise<UsageReservation> => {
    if (records.some((r) => r.id === input.webhookEventId)) return "duplicate";
    if (records.length >= limits.shopPerDay) return "shop_daily_limit";
    const mine = records.filter((r) => r.user === input.lineUserId).length;
    if (mine >= limits.userPerDay) return "user_daily_limit";
    if (mine >= limits.userPer10Minutes) return "user_burst_limit";
    records.push({ id: input.webhookEventId, user: input.lineUserId });
    return "reserved";
  });
  const limiter: AiUsageLimiter = { reserve };
  return { limiter, reserve, records };
}
