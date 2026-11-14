import { afterEach, describe, expect, it, vi } from "vitest";
import { createResponderFromEnv, resolveResponderKind } from "@/lib/bot/config";
import { echoResponder } from "@/lib/line/process-events";
import { SUPABASE_PROJECT_REF } from "@/lib/supabase/server";
import { silentLogger } from "../line/fixtures";

// 実在しないダミー値。Supabase・Claude には接続しない（fetch はスタブして呼ばれないことを確認）
const SUPABASE = {
  SUPABASE_URL: `https://${SUPABASE_PROJECT_REF}.supabase.co`,
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_DUMMYdummyDUMMYdummy0123",
};
const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;

afterEach(() => vi.unstubAllGlobals());

describe("LINE_RESPONDER の切り替え", () => {
  it("未設定は echo（既存の動作を維持）", () => {
    expect(resolveResponderKind(env({}))).toBe("echo");
    expect(createResponderFromEnv(env({}))).toBe(echoResponder);
  });

  it("不正な値はエラー", () => {
    expect(() => resolveResponderKind(env({ LINE_RESPONDER: "claude" }))).toThrow(/LINE_RESPONDER/);
  });

  it("本番（VERCEL_ENV=production）では echo を使わせない", () => {
    expect(() => resolveResponderKind(env({ VERCEL_ENV: "production" }))).toThrow(/not allowed in production/);
    expect(resolveResponderKind(env({ VERCEL_ENV: "production", LINE_RESPONDER: "ai" }))).toBe("ai");
  });

  it("ai には Supabase の接続情報が必要", () => {
    expect(() => createResponderFromEnv(env({ LINE_RESPONDER: "ai" }))).toThrow(/SUPABASE_URL/);
  });

  it("ai で API キー未設定でも作成できる（警告のみ）。作成時に外部へ接続しない", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const logger = silentLogger();
    const respond = createResponderFromEnv(env({ LINE_RESPONDER: "ai", ...SUPABASE }), logger);
    expect(typeof respond).toBe("function");
    expect(respond).not.toBe(echoResponder);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ANTHROPIC_API_KEY is not set"));
    expect(fetch).not.toHaveBeenCalled();
  });
});
