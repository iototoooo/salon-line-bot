import type { ServerSupabaseClient } from "@/lib/supabase/server";
import type { FaqRow, MenuRow, ShopSettingsRow } from "@/types/database";
import { DbError, unwrap } from "./errors";

/** 店舗基本情報（常に 1 行）。AI 応答の根拠・自動応答 ON/OFF の判定に使う */
export async function getShopSettings(db: ServerSupabaseClient): Promise<ShopSettingsRow> {
  const row = unwrap("getShopSettings", await db.from("shop_settings").select("*").eq("id", 1).maybeSingle());
  if (!row) throw new DbError("getShopSettings", "not_found");
  return row;
}

/** 公開中の FAQ（表示順） */
export async function listPublishedFaqs(db: ServerSupabaseClient): Promise<FaqRow[]> {
  return (
    unwrap(
      "listPublishedFaqs",
      await db.from("faqs").select("*").eq("is_published", true).order("sort_order").order("created_at"),
    ) ?? []
  );
}

/** 公開中のメニュー（カテゴリ・表示順） */
export async function listPublishedMenus(db: ServerSupabaseClient): Promise<MenuRow[]> {
  return (
    unwrap(
      "listPublishedMenus",
      await db
        .from("menus")
        .select("*")
        .eq("is_published", true)
        .order("category")
        .order("sort_order")
        .order("created_at"),
    ) ?? []
  );
}
