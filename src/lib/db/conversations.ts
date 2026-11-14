import type { ServerSupabaseClient } from "@/lib/supabase/server";
import type { ConversationInsert, ConversationRow } from "@/types/database";
import { unwrap } from "./errors";

/**
 * 会話ログを保存する。line_event_id が既にあれば何もしない（冪等）。
 * @returns 新しく保存した場合は true、既に保存済みなら false
 */
export async function insertConversation(db: ServerSupabaseClient, row: ConversationInsert): Promise<boolean> {
  const data = unwrap(
    "insertConversation",
    await db
      .from("conversations")
      .upsert(row, { onConflict: "line_event_id", ignoreDuplicates: true })
      .select("id"),
  );
  return (data?.length ?? 0) > 0;
}

/** オーナーへ通知した日時を記録する */
export async function markConversationOwnerNotified(db: ServerSupabaseClient, lineEventId: string): Promise<void> {
  unwrap(
    "markConversationOwnerNotified",
    await db
      .from("conversations")
      .update({ owner_notified_at: new Date().toISOString() })
      .eq("line_event_id", lineEventId)
      .is("owner_notified_at", null),
  );
}

/** 未対応（要オーナー対応かつ未解決）の会話を新しい順に取得する */
export async function listUnresolvedConversations(
  db: ServerSupabaseClient,
  limit = 50,
): Promise<ConversationRow[]> {
  return (
    unwrap(
      "listUnresolvedConversations",
      await db
        .from("conversations")
        .select("*")
        .eq("needs_owner", true)
        .is("resolved_at", null)
        .order("created_at", { ascending: false })
        .limit(limit),
    ) ?? []
  );
}
