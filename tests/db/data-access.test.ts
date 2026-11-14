import { describe, expect, it, vi } from "vitest";
import { insertConversation, listUnresolvedConversations } from "@/lib/db/conversations";
import { DbError } from "@/lib/db/errors";
import { getShopSettings } from "@/lib/db/shop";
import type { ServerSupabaseClient } from "@/lib/supabase/server";

/** supabase-js のクエリビルダーを模したフェイク。呼ばれたメソッドを記録し、最後に result を返す */
function fakeDb(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["from", "select", "upsert", "update", "eq", "is", "order", "limit", "maybeSingle"]) {
    builder[m] = vi.fn((...args: unknown[]) => {
      calls.push([m, args]);
      return builder;
    });
  }
  builder.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return { db: builder as unknown as ServerSupabaseClient, calls };
}

const conv = {
  line_event_id: "ev1",
  line_user_id: `U${"0".repeat(32)}`,
  message_type: "text",
  ai_status: "answered" as const,
};

describe("データアクセス層（Supabase はフェイク）", () => {
  it("insertConversation は line_event_id で冪等に保存する", async () => {
    const { db, calls } = fakeDb({ data: [{ id: "1" }], error: null });
    expect(await insertConversation(db, conv)).toBe(true);
    expect(calls).toContainEqual(["upsert", [conv, { onConflict: "line_event_id", ignoreDuplicates: true }]]);
  });

  it("既に保存済みなら false", async () => {
    const { db } = fakeDb({ data: [], error: null });
    expect(await insertConversation(db, conv)).toBe(false);
  });

  it("エラーは DbError（コードのみ・詳細メッセージは含めない）", async () => {
    const { db } = fakeDb({ data: null, error: { message: "row contains 秘密", code: "23505" } });
    const err = await insertConversation(db, conv).catch((e) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err.message).toContain("23505");
    expect(err.message).not.toContain("秘密");
  });

  it("未対応一覧は needs_owner かつ未解決で絞り込む", async () => {
    const { db, calls } = fakeDb({ data: [], error: null });
    await listUnresolvedConversations(db, 10);
    expect(calls).toContainEqual(["eq", ["needs_owner", true]]);
    expect(calls).toContainEqual(["is", ["resolved_at", null]]);
    expect(calls).toContainEqual(["limit", [10]]);
  });

  it("店舗情報が存在しなければ DbError", async () => {
    const { db } = fakeDb({ data: null, error: null });
    await expect(getShopSettings(db)).rejects.toThrow(DbError);
  });
});
