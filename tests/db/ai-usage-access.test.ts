import { describe, expect, it, vi } from "vitest";
import { AI_USAGE_LIMITS } from "@/lib/ai/usage-limit";
import { reserveAiUsage } from "@/lib/db/ai-usage";
import { DbError } from "@/lib/db/errors";
import type { ServerSupabaseClient } from "@/lib/supabase/server";

// supabase-js の rpc を模したフェイク（実際の Supabase には接続しない）
function fakeRpc(result: { data: unknown; error: { message: string; code?: string } | null }) {
  const rpc = vi.fn(async () => result);
  return { db: { rpc } as unknown as ServerSupabaseClient, rpc };
}
const input = { webhookEventId: "01EV", lineUserId: `U${"0".repeat(32)}` };

describe("reserveAiUsage（データアクセス層）", () => {
  it("初期値の上限（10 分 5 回・1 日 30 回・店舗 300 回）で reserve_ai_usage を呼ぶ", async () => {
    const { db, rpc } = fakeRpc({ data: "reserved", error: null });
    expect(await reserveAiUsage(db, input)).toBe("reserved");
    expect(rpc).toHaveBeenCalledWith("reserve_ai_usage", {
      p_webhook_event_id: "01EV",
      p_line_user_id: input.lineUserId,
      p_user_burst_limit: 5,
      p_user_daily_limit: 30,
      p_shop_daily_limit: 300,
    });
    expect(AI_USAGE_LIMITS).toEqual({ userPer10Minutes: 5, userPerDay: 30, shopPerDay: 300 });
  });

  it.each(["duplicate", "user_burst_limit", "user_daily_limit", "shop_daily_limit"])("%s をそのまま返す", async (v) => {
    const { db } = fakeRpc({ data: v, error: null });
    expect(await reserveAiUsage(db, input)).toBe(v);
  });

  it("DB エラーは DbError（コードのみ。メッセージやユーザー ID を含めない）", async () => {
    const { db } = fakeRpc({ data: null, error: { message: `invalid line user id ${input.lineUserId}`, code: "P0001" } });
    const err = await reserveAiUsage(db, input).catch((e) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err.message).toContain("P0001");
    expect(err.message).not.toContain(input.lineUserId);
  });

  it.each([[null], ["allowed"], [true], [1]])("想定外の戻り値 %j は DbError（AI を呼ばない側に倒す）", async (data) => {
    const { db } = fakeRpc({ data, error: null });
    await expect(reserveAiUsage(db, input)).rejects.toThrow(DbError);
  });
});
