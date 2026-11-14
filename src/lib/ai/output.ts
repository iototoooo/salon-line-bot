import type { FaqCategory } from "@/types/database";

/**
 * AI 出力（構造化出力の JSON）の形式と検証。
 *
 * API 側でも JSON スキーマで形式を強制するが、それだけに頼らず、ここで型・値・長さを再検証する。
 * 構造化出力は maxLength などの制約に対応していないため、長さの検証はコード側で行う。
 */

export const AI_DRAFT_STATUSES = ["answered", "cannot_answer", "reservation"] as const;
export type AiDraftStatus = (typeof AI_DRAFT_STATUSES)[number];

export const FAQ_CATEGORIES: readonly FaqCategory[] = ["hours", "price", "reservation", "treatment", "access", "other"];

export type AiDraft = {
  status: AiDraftStatus;
  answer: string;
  category: FaqCategory;
  faq_refs: string[];
  menu_refs: string[];
  shop_refs: string[];
  reason: string;
};

/** API の output_config.format に渡す JSON スキーマ（構造化出力の制約に合わせ、全 object で additionalProperties: false） */
export const AI_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: [...AI_DRAFT_STATUSES] },
    answer: { type: "string", description: "お客様へ送る文章（200 文字程度まで）" },
    category: { type: "string", enum: [...FAQ_CATEGORIES] },
    faq_refs: { type: "array", items: { type: "string" }, description: "根拠にした FAQ の参照 ID（例 F1）" },
    menu_refs: { type: "array", items: { type: "string" }, description: "根拠にしたメニューの参照 ID（例 M1）" },
    shop_refs: { type: "array", items: { type: "string" }, description: "根拠にした店舗情報の参照 ID（例 S:phone）" },
    reason: { type: "string", description: "cannot_answer / reservation の理由（短文・個人情報なし）" },
  },
  required: ["status", "answer", "category", "faq_refs", "menu_refs", "shop_refs", "reason"],
  additionalProperties: false,
} as const;

/** 1 つの参照リストに入れられる最大数（異常な出力の検出） */
const MAX_REFS = 20;
/** 解析時に受け付ける回答の最大文字数（これを超える出力は異常とみなす。送信可否は guard で判定） */
const MAX_RAW_ANSWER = 2000;
const MAX_REASON = 300;

export type ParseResult = { ok: true; draft: AiDraft } | { ok: false; error: "invalid_json" | "schema_mismatch" };

export function parseAiOutput(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: "schema_mismatch" };
  const v = value as Record<string, unknown>;

  const allowedKeys = new Set(AI_OUTPUT_SCHEMA.required as readonly string[]);
  if (Object.keys(v).some((k) => !allowedKeys.has(k))) return { ok: false, error: "schema_mismatch" };

  const status = v.status;
  const category = v.category;
  if (typeof status !== "string" || !(AI_DRAFT_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: "schema_mismatch" };
  }
  if (typeof category !== "string" || !(FAQ_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, error: "schema_mismatch" };
  }
  if (typeof v.answer !== "string" || v.answer.length > MAX_RAW_ANSWER) return { ok: false, error: "schema_mismatch" };
  if (typeof v.reason !== "string") return { ok: false, error: "schema_mismatch" };

  const refs = (x: unknown): string[] | null =>
    Array.isArray(x) && x.length <= MAX_REFS && x.every((r) => typeof r === "string" && r.length <= 40)
      ? [...new Set(x as string[])]
      : null;
  const faqRefs = refs(v.faq_refs);
  const menuRefs = refs(v.menu_refs);
  const shopRefs = refs(v.shop_refs);
  if (!faqRefs || !menuRefs || !shopRefs) return { ok: false, error: "schema_mismatch" };

  return {
    ok: true,
    draft: {
      status: status as AiDraftStatus,
      answer: v.answer,
      category: category as FaqCategory,
      faq_refs: faqRefs,
      menu_refs: menuRefs,
      shop_refs: shopRefs,
      reason: v.reason.trim().slice(0, MAX_REASON),
    },
  };
}
