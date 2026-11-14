import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnerNotifierFromEnv } from "@/lib/notify/config";
import { SUPABASE_PROJECT_REF } from "@/lib/supabase/server";
import { silentLogger } from "../line/fixtures";

// 実在しないダミー値。Supabase・LINE には接続しない（fetch はスタブ）
const SUPABASE = {
  SUPABASE_URL: `https://${SUPABASE_PROJECT_REF}.supabase.co`,
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_DUMMYdummyDUMMYdummy0123",
};
const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;

afterEach(() => vi.unstubAllGlobals());

describe("オーナー通知の設定", () => {
  it("Supabase の接続情報がない（memory ストア）なら通知しない（null）", () => {
    expect(createOwnerNotifierFromEnv(env({}))).toBeNull();
    expect(createOwnerNotifierFromEnv(env({ ...SUPABASE, WEBHOOK_EVENT_STORE: "memory" }))).toBeNull();
  });

  it("LINE_REPLY_MODE が live でなければ dry-run（DB にも LINE にも接続しない）", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const notifier = createOwnerNotifierFromEnv(env({ ...SUPABASE, LINE_CHANNEL_ACCESS_TOKEN: "dummy" }), silentLogger());
    expect(await notifier!.flush()).toBe("dry_run");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("live でもアクセストークンがなければ dry-run", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const notifier = createOwnerNotifierFromEnv(env({ ...SUPABASE, LINE_REPLY_MODE: "live" }), silentLogger());
    expect(await notifier!.flush()).toBe("dry_run");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("live：通知先を DB から読む。読めなければ LINE へは送らない", async () => {
    // 店舗情報が 0 行（読めない）という応答を返すスタブ。実際の Supabase には接続しない
    const fetch = vi.fn(
      async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const logger = silentLogger();
    const notifier = createOwnerNotifierFromEnv(
      env({ ...SUPABASE, LINE_REPLY_MODE: "live", LINE_CHANNEL_ACCESS_TOKEN: "dummy" }),
      logger,
    );
    expect(await notifier!.flush()).toBe("error");
    const urls = fetch.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls.some((u) => u.includes("api.line.me"))).toBe(false);
  });
});
