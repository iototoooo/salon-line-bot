import { vi } from "vitest";
import type { AnswerModel, ModelRequest, ModelResponse } from "@/lib/ai/claude-model";
import { buildKnowledge } from "@/lib/ai/knowledge";
import type { FaqRow, MenuRow, ShopSettingsRow } from "@/types/database";

/**
 * テスト専用の架空の店舗データ。実在の店舗・電話番号ではない。
 * 本番 DB には登録しない（実際の営業時間・料金・施術条件・駐車場は未確定）。
 */
export const FAKE_PHONE = "00-0000-0000";
const T = "2026-11-11T00:00:00+00:00";

export function shopRow(overrides: Partial<ShopSettingsRow> = {}): ShopSettingsRow {
  return {
    id: 1,
    shop_name: "架空サロン テスト店",
    business_hours: "10:00〜19:00（最終受付 18:00）",
    regular_holidays: "毎週火曜日",
    address: "",
    phone: FAKE_PHONE,
    parking: "店舗前に 2 台分の駐車場があります。",
    reservation_guide: `ご予約はお電話（${FAKE_PHONE}）で承っております。`,
    temporary_notice: "",
    bot_enabled: true,
    fallback_message: "担当者から折り返しご連絡いたします。",
    owner_line_user_id: null,
    updated_at: T,
    ...overrides,
  };
}

/** 空欄だらけの店舗情報（未確定の状態） */
export function emptyShopRow(overrides: Partial<ShopSettingsRow> = {}): ShopSettingsRow {
  return shopRow({
    shop_name: "",
    business_hours: "",
    regular_holidays: "",
    phone: "",
    parking: "",
    reservation_guide: "",
    ...overrides,
  });
}

export const MENU_IDS = {
  cut: "a0000000-0000-4000-8000-000000000001",
  color: "a0000000-0000-4000-8000-000000000002",
  perm: "a0000000-0000-4000-8000-000000000003",
};
export const FAQ_IDS = {
  permColor: "b0000000-0000-4000-8000-000000000001",
  card: "b0000000-0000-4000-8000-000000000002",
};

const menu = (id: string, name: string, category: MenuRow["category"], price: number, extra: Partial<MenuRow> = {}): MenuRow => ({
  id,
  name,
  category,
  price,
  price_note: "",
  duration_min: 60,
  description: "",
  is_published: true,
  sort_order: 0,
  created_at: T,
  updated_at: T,
  ...extra,
});

export const MENUS: MenuRow[] = [
  menu(MENU_IDS.cut, "カット", "cut", 4400),
  menu(MENU_IDS.color, "カラー", "color", 6600, { price_note: "ロング料金 +1,100円" }),
  menu(MENU_IDS.perm, "パーマ", "perm", 8800, { duration_min: 120 }),
];

const faq = (id: string, question: string, answer: string, category: FaqRow["category"]): FaqRow => ({
  id,
  question,
  answer,
  category,
  is_published: true,
  sort_order: 0,
  created_at: T,
  updated_at: T,
});

export const FAQS: FaqRow[] = [
  faq(FAQ_IDS.permColor, "パーマとカラーは同時にできますか？", "同じ日に施術できます。所要時間は 3 時間ほどです。", "treatment"),
  faq(FAQ_IDS.card, "クレジットカードは使えますか？", "各種クレジットカードをご利用いただけます。", "other"),
];

export const knowledge = (shop = shopRow(), faqs = FAQS, menus = MENUS) => buildKnowledge(shop, faqs, menus);

/** AI の出力（構造化出力の JSON）を作る */
export function draft(over: Record<string, unknown> = {}) {
  return {
    status: "answered",
    answer: "",
    category: "other",
    faq_refs: [],
    menu_refs: [],
    shop_refs: [],
    reason: "",
    ...over,
  };
}

/**
 * Claude のモック。実際の API は呼ばない。
 * output が文字列ならそのまま、オブジェクトなら JSON にして返す。Error を渡すと例外を投げる。
 */
export function fakeModel(output: unknown, response: Partial<ModelResponse> = {}) {
  // 引数（ModelRequest）は mock.calls で検証する
  const generate = vi.fn<(req: ModelRequest) => Promise<ModelResponse>>(async () => {
    if (output instanceof Error) throw output;
    return {
      text: typeof output === "string" ? output : JSON.stringify(output),
      stopReason: "end_turn",
      model: "claude-haiku-5-5",
      inputTokens: 1200,
      outputTokens: 80,
      ...response,
    };
  });
  const model: AnswerModel = { model: "claude-haiku-5-5", generate };
  return { model, generate };
}
