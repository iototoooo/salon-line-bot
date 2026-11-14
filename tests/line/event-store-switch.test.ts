import { describe, expect, it, vi } from "vitest";
import { createWebhookEventStore, resolveEventStoreKind } from "@/lib/line/config";
import { InMemoryWebhookEventStore, WebhookEventStoreError } from "@/lib/line/event-store";
import { SupabaseWebhookEventStore } from "@/lib/line/supabase-event-store";
import { readSupabaseServerConfig, SupabaseConfigError, type ServerSupabaseClient } from "@/lib/supabase/server";

const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;
// テスト用のダミー値（実在しない。接続はしない）。URL は本案件のプロジェクト以外を拒否するため対象の URL を使う
const SUPABASE = {
  SUPABASE_URL: "https://dnortggovlwgcdeoadbf.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_DUMMYdummyDUMMYdummy0123",
};

describe("重複判定ストアの切り替え", () => {
  it("未指定で Supabase 設定がなければ memory", () => {
    expect(resolveEventStoreKind(env({}))).toBe("memory");
  });

  it("未指定で Supabase 設定があれば supabase", () => {
    expect(resolveEventStoreKind(env(SUPABASE))).toBe("supabase");
  });

  it("WEBHOOK_EVENT_STORE で明示できる。不正値はエラー", () => {
    expect(resolveEventStoreKind(env({ ...SUPABASE, WEBHOOK_EVENT_STORE: "memory" }))).toBe("memory");
    expect(() => resolveEventStoreKind(env({ WEBHOOK_EVENT_STORE: "redis" }))).toThrow(SupabaseConfigError);
  });

  it("supabase を指定したのに接続情報がなければエラー（黙ってメモリにしない）", () => {
    expect(() => createWebhookEventStore(env({ WEBHOOK_EVENT_STORE: "supabase" }))).toThrow(SupabaseConfigError);
  });

  it("本番（VERCEL_ENV=production）ではメモリ実装を使えない", () => {
    expect(() => createWebhookEventStore(env({ VERCEL_ENV: "production" }))).toThrow(/not allowed in production/);
  });

  it("開発ではメモリ実装、Supabase 設定ありなら Supabase 実装（接続はしない）", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createWebhookEventStore(env({}))).toBeInstanceOf(InMemoryWebhookEventStore);
    expect(createWebhookEventStore(env(SUPABASE))).toBeInstanceOf(SupabaseWebhookEventStore);
  });

  it("SUPABASE_URL がなければ NEXT_PUBLIC_SUPABASE_URL を使う。URL 形式でなければエラー", () => {
    expect(
      readSupabaseServerConfig(
        env({ NEXT_PUBLIC_SUPABASE_URL: SUPABASE.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SUPABASE.SUPABASE_SERVICE_ROLE_KEY }),
      ),
    ).toMatchObject({ url: SUPABASE.SUPABASE_URL, serviceRoleKey: SUPABASE.SUPABASE_SERVICE_ROLE_KEY });
    expect(() =>
      readSupabaseServerConfig(env({ SUPABASE_URL: "x.example", SUPABASE_SERVICE_ROLE_KEY: SUPABASE.SUPABASE_SERVICE_ROLE_KEY })),
    ).toThrow(SupabaseConfigError);
  });
});

describe("SupabaseWebhookEventStore（rpc はモック）", () => {
  function storeWith(result: { data: unknown; error: unknown }) {
    const rpc = vi.fn().mockResolvedValue(result);
    return { rpc, store: new SupabaseWebhookEventStore({ rpc } as unknown as ServerSupabaseClient) };
  }

  it("claim は DB 関数に正しい引数を渡す（返信期限 50 秒）", async () => {
    const { rpc, store } = storeWith({ data: true, error: null });
    expect(
      await store.claim({ webhookEventId: "ev", eventType: "message", isRedelivery: true, eventTimestamp: 0 }),
    ).toBe(true);
    expect(rpc).toHaveBeenCalledWith("claim_line_webhook_event", {
      p_webhook_event_id: "ev",
      p_event_type: "message",
      p_is_redelivery: true,
      p_event_timestamp: "1970-01-01T00:00:00.000Z",
      p_reply_window: "50 seconds",
    });
  });

  it("DB エラーは WebhookEventStoreError（メッセージにはエラーコードのみ）", async () => {
    const { store } = storeWith({ data: null, error: { message: "secret detail", code: "PGRST301" } });
    const err = await store.beginReply("ev").catch((e) => e);
    expect(err).toBeInstanceOf(WebhookEventStoreError);
    expect(err.message).toContain("PGRST301");
    expect(err.message).not.toContain("secret detail");
  });

  it("応答が空ならエラー", async () => {
    const { store } = storeWith({ data: null, error: null });
    await expect(store.finish("ev", "done")).rejects.toThrow(WebhookEventStoreError);
  });

  it("finish は要通知フラグとエラー概要を渡す", async () => {
    const { rpc, store } = storeWith({ data: true, error: null });
    await store.finish("ev", "failed", { error: "reply_unknown", needsOwnerNotification: true });
    expect(rpc).toHaveBeenCalledWith("finish_line_webhook_event", {
      p_webhook_event_id: "ev",
      p_status: "failed",
      p_error: "reply_unknown",
      p_needs_owner_notification: true,
    });
  });
});
