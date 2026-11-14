import { DbError, unwrap } from "@/lib/db/errors";
import type { BroadcastRow, ConversationRow, FaqRow, MenuRow, ShopSettingsRow } from "@/types/database";
import type { SessionClient } from "./auth-core";
import type { FaqInput, MenuInput, ShopInfoInput } from "./validation";

/**
 * 管理画面の DB 操作。すべてログイン中のセッション（authenticated ロール）で行い、RLS（管理者のみ）と
 * 列単位の権限（初期マイグレーションの GRANT）がそのまま適用される。secret キーは使わない。
 * エラーは DbError（コードのみ）。画面には日本語の定型文を出す。
 */

// ---------------------------------------------------------------------------
// ホーム
// ---------------------------------------------------------------------------
export type DashboardSummary = {
  unresolved: number;
  faqs: number;
  publishedFaqs: number;
  menus: number;
  shop: Pick<ShopSettingsRow, "bot_enabled" | "shop_name"> & { ownerSet: boolean };
};

const HEAD_COUNT = { count: "exact", head: true } as const;

function countOf(op: string, result: { count: number | null; error: { code?: string } | null }): number {
  if (result.error) throw new DbError(op, result.error.code);
  return result.count ?? 0;
}

export async function getDashboardSummary(db: SessionClient): Promise<DashboardSummary> {
  const [u, f, pf, m, shop] = await Promise.all([
    db.from("conversations").select("id", HEAD_COUNT).eq("needs_owner", true).is("resolved_at", null),
    db.from("faqs").select("id", HEAD_COUNT),
    db.from("faqs").select("id", HEAD_COUNT).eq("is_published", true),
    db.from("menus").select("id", HEAD_COUNT),
    getShop(db),
  ]);
  const unresolved = countOf("count:unresolved", u);
  const faqs = countOf("count:faqs", f);
  const publishedFaqs = countOf("count:published_faqs", pf);
  const menus = countOf("count:menus", m);
  return {
    unresolved,
    faqs,
    publishedFaqs,
    menus,
    shop: { bot_enabled: shop.bot_enabled, shop_name: shop.shop_name, ownerSet: shop.owner_line_user_id !== null },
  };
}

// ---------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------
export async function listFaqs(db: SessionClient): Promise<FaqRow[]> {
  return unwrap("listFaqs", await db.from("faqs").select("*").order("sort_order").order("created_at")) ?? [];
}

export async function createFaq(db: SessionClient, input: FaqInput): Promise<void> {
  unwrap("createFaq", await db.from("faqs").insert(input));
}

export async function updateFaq(db: SessionClient, id: string, input: FaqInput): Promise<boolean> {
  const data = unwrap("updateFaq", await db.from("faqs").update(input).eq("id", id).select("id"));
  return (data?.length ?? 0) > 0;
}

export async function setFaqPublished(db: SessionClient, id: string, published: boolean): Promise<boolean> {
  const data = unwrap("setFaqPublished", await db.from("faqs").update({ is_published: published }).eq("id", id).select("id"));
  return (data?.length ?? 0) > 0;
}

export async function deleteFaq(db: SessionClient, id: string): Promise<boolean> {
  const data = unwrap("deleteFaq", await db.from("faqs").delete().eq("id", id).select("id"));
  return (data?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// メニュー
// ---------------------------------------------------------------------------
export async function listMenus(db: SessionClient): Promise<MenuRow[]> {
  return (
    unwrap("listMenus", await db.from("menus").select("*").order("category").order("sort_order").order("created_at")) ?? []
  );
}

export async function createMenu(db: SessionClient, input: MenuInput): Promise<void> {
  unwrap("createMenu", await db.from("menus").insert(input));
}

export async function updateMenu(db: SessionClient, id: string, input: MenuInput): Promise<boolean> {
  const data = unwrap("updateMenu", await db.from("menus").update(input).eq("id", id).select("id"));
  return (data?.length ?? 0) > 0;
}

export async function setMenuPublished(db: SessionClient, id: string, published: boolean): Promise<boolean> {
  const data = unwrap("setMenuPublished", await db.from("menus").update({ is_published: published }).eq("id", id).select("id"));
  return (data?.length ?? 0) > 0;
}

export async function deleteMenu(db: SessionClient, id: string): Promise<boolean> {
  const data = unwrap("deleteMenu", await db.from("menus").delete().eq("id", id).select("id"));
  return (data?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// 店舗情報・設定（shop_settings は 1 行のみ。authenticated が更新できる列は GRANT で限定済み）
// ---------------------------------------------------------------------------
export async function getShop(db: SessionClient): Promise<ShopSettingsRow> {
  const row = unwrap("getShop", await db.from("shop_settings").select("*").eq("id", 1).maybeSingle());
  if (!row) throw new DbError("getShop", "not_found");
  return row;
}

async function updateShop(
  db: SessionClient,
  op: string,
  patch: Partial<Pick<ShopSettingsRow, keyof ShopInfoInput | "bot_enabled" | "owner_line_user_id">>,
): Promise<boolean> {
  const data = unwrap(op, await db.from("shop_settings").update(patch).eq("id", 1).select("id"));
  return (data?.length ?? 0) > 0;
}

export const updateShopInfo = (db: SessionClient, input: ShopInfoInput) => updateShop(db, "updateShopInfo", input);
export const setBotEnabled = (db: SessionClient, enabled: boolean) => updateShop(db, "setBotEnabled", { bot_enabled: enabled });
export const setOwnerLineUserId = (db: SessionClient, id: string | null) =>
  updateShop(db, "setOwnerLineUserId", { owner_line_user_id: id });

// ---------------------------------------------------------------------------
// 会話ログ・未対応一覧
// ---------------------------------------------------------------------------
export type ConversationListItem = Pick<
  ConversationRow,
  | "id"
  | "line_user_id"
  | "message_type"
  | "user_message"
  | "ai_status"
  | "ai_category"
  | "bot_reply"
  | "reply_method"
  | "needs_owner"
  | "owner_notified_at"
  | "resolved_at"
  | "created_at"
  | "error_message"
  | "ai_reason"
>;

const CONVERSATION_COLUMNS =
  "id,line_user_id,message_type,user_message,ai_status,ai_category,bot_reply,reply_method,needs_owner,owner_notified_at,resolved_at,created_at,error_message,ai_reason";

export type ConversationFilter = {
  /** 日本時間の日付（YYYY-MM-DD）。指定した日の分だけ */
  date?: string;
  unresolvedOnly?: boolean;
  limit?: number;
};

export const MAX_LIST = 100;

/** 日本時間の日付の範囲（UTC の ISO 文字列） */
export function jstDayRange(date: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const start = new Date(`${date}T00:00:00+09:00`);
  if (Number.isNaN(start.getTime())) return null;
  return { from: start.toISOString(), to: new Date(start.getTime() + 86_400_000).toISOString() };
}

export async function listConversations(db: SessionClient, filter: ConversationFilter = {}): Promise<ConversationListItem[]> {
  let q = db.from("conversations").select(CONVERSATION_COLUMNS);
  if (filter.unresolvedOnly) q = q.eq("needs_owner", true).is("resolved_at", null);
  const range = filter.date ? jstDayRange(filter.date) : null;
  if (range) q = q.gte("created_at", range.from).lt("created_at", range.to);
  const limit = Math.min(Math.max(filter.limit ?? MAX_LIST, 1), MAX_LIST);
  return unwrap("listConversations", await q.order("created_at", { ascending: false }).limit(limit)) ?? [];
}

/**
 * 対応済みにする。RLS（conversations_resolve）で resolved_by はログイン中の本人だけが入れられる。
 * 未対応（要対応かつ未解決）のものだけを更新し、二重に押しても日時は変わらない。
 */
export async function resolveConversation(db: SessionClient, id: string, adminUserId: string): Promise<boolean> {
  const data = unwrap(
    "resolveConversation",
    await db
      .from("conversations")
      .update({ resolved_at: new Date().toISOString(), resolved_by: adminUserId })
      .eq("id", id)
      .eq("needs_owner", true)
      .is("resolved_at", null)
      .select("id"),
  );
  return (data?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// 一斉配信（authenticated ができるのは下書きの作成・本文の編集・未送信分の削除だけ。状態の変更はサーバーが行う）
// ---------------------------------------------------------------------------
export async function listBroadcasts(db: SessionClient): Promise<BroadcastRow[]> {
  return unwrap("listBroadcasts", await db.from("broadcasts").select("*").order("created_at", { ascending: false }).limit(50)) ?? [];
}

export async function getBroadcast(db: SessionClient, id: string): Promise<BroadcastRow | null> {
  return unwrap("getBroadcast", await db.from("broadcasts").select("*").eq("id", id).maybeSingle());
}

export async function createBroadcastDraft(db: SessionClient, body: string): Promise<string> {
  // authenticated に INSERT できるのは body 列だけ（id・状態は DB が決める）。採番された id を返す
  const { data, error } = await db.from("broadcasts").insert({ body }).select("id");
  if (error) throw new DbError("createBroadcastDraft", error.code);
  const id = (data as ReadonlyArray<{ id: string }> | null)?.[0]?.id;
  if (!id) throw new DbError("createBroadcastDraft", "no_row");
  return id;
}

/** 本文の編集（送信中・送信済みは DB のトリガーが拒否する。変更すると下書きに戻り、テスト送信からやり直し） */
export async function updateBroadcastBody(db: SessionClient, id: string, body: string): Promise<boolean> {
  const data = unwrap(
    "updateBroadcastBody",
    await db.from("broadcasts").update({ body }).eq("id", id).in("status", ["draft", "tested", "failed"]).select("id"),
  );
  return (data?.length ?? 0) > 0;
}

export async function deleteBroadcast(db: SessionClient, id: string): Promise<boolean> {
  const data = unwrap("deleteBroadcast", await db.from("broadcasts").delete().eq("id", id).in("status", ["draft", "tested"]).select("id"));
  return (data?.length ?? 0) > 0;
}
