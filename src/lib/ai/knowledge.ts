import type { FaqCategory, FaqRow, MenuCategory, MenuRow, ShopKnowledgeField, ShopSettingsRow } from "@/types/database";

/**
 * AI 回答の根拠になる登録情報（店舗情報・メニュー・FAQ）。
 *
 * - AI には実際の UUID ではなく短い参照 ID（F1, M1, S:phone）を渡し、回答の根拠として返させる
 *   （トークン節約と、存在しない ID の捏造をコード側で検出しやすくするため）
 * - 参照 ID と実際の UUID の対応はここで保持し、会話ログには UUID を記録する
 * - 件数・文字数に上限を設けて、1 回あたりの入力トークン（＝費用）が増えすぎないようにする
 */

export const SHOP_KNOWLEDGE_FIELDS: readonly ShopKnowledgeField[] = [
  "shop_name",
  "business_hours",
  "regular_holidays",
  "address",
  "phone",
  "parking",
  "reservation_guide",
  "temporary_notice",
];

export const SHOP_FIELD_LABELS: Record<ShopKnowledgeField, string> = {
  shop_name: "店名",
  business_hours: "営業時間",
  regular_holidays: "定休日",
  address: "住所",
  phone: "電話番号",
  parking: "駐車場",
  reservation_guide: "予約方法",
  temporary_notice: "臨時のお知らせ",
};

export type KnowledgeFaq = {
  ref: string;
  id: string;
  category: FaqCategory;
  question: string;
  answer: string;
};

export type KnowledgeMenu = {
  ref: string;
  id: string;
  category: MenuCategory;
  name: string;
  /** 税込・円（DB の値をそのまま使う） */
  price: number;
  priceNote: string;
  durationMin: number | null;
  description: string;
};

export type Knowledge = {
  /** 空欄の項目は空文字（プロンプトでは「未登録」と表示する） */
  shop: Record<ShopKnowledgeField, string>;
  faqs: KnowledgeFaq[];
  menus: KnowledgeMenu[];
  /** 上限を超えて一部を省いた場合 true */
  truncated: boolean;
};

/**
 * プロンプトに含める登録情報の上限（費用の上限管理）。
 * メニューと FAQ は別々の上限にし、片方が多すぎてもう片方がすべて落ちることを防ぐ。
 * 店舗情報の各項目は DB の CHECK 制約で長さが制限されている（合計 5,000 文字程度）ため、ここでは切り詰めない。
 */
export const KNOWLEDGE_LIMITS = {
  maxFaqs: 100,
  maxMenus: 100,
  /** メニュー（名前・備考・説明）の合計文字数 */
  maxMenuChars: 10_000,
  /** FAQ（質問・回答）の合計文字数 */
  maxFaqChars: 20_000,
} as const;

export function buildKnowledge(shop: ShopSettingsRow, faqs: FaqRow[], menus: MenuRow[]): Knowledge {
  const shopValues = {} as Record<ShopKnowledgeField, string>;
  for (const field of SHOP_KNOWLEDGE_FIELDS) shopValues[field] = (shop[field] ?? "").trim();

  let chars = 0;
  let truncated = false;

  const outMenus: KnowledgeMenu[] = [];
  for (const m of menus) {
    const size = m.name.length + m.price_note.length + m.description.length;
    if (outMenus.length >= KNOWLEDGE_LIMITS.maxMenus || chars + size > KNOWLEDGE_LIMITS.maxMenuChars) {
      truncated = true;
      break;
    }
    chars += size;
    outMenus.push({
      ref: `M${outMenus.length + 1}`,
      id: m.id,
      category: m.category,
      name: m.name.trim(),
      price: m.price,
      priceNote: m.price_note.trim(),
      durationMin: m.duration_min,
      description: m.description.trim(),
    });
  }

  chars = 0;
  const outFaqs: KnowledgeFaq[] = [];
  for (const f of faqs) {
    const size = f.question.length + f.answer.length;
    if (outFaqs.length >= KNOWLEDGE_LIMITS.maxFaqs || chars + size > KNOWLEDGE_LIMITS.maxFaqChars) {
      truncated = true;
      break;
    }
    chars += size;
    outFaqs.push({
      ref: `F${outFaqs.length + 1}`,
      id: f.id,
      category: f.category,
      question: f.question.trim(),
      answer: f.answer.trim(),
    });
  }

  return { shop: shopValues, faqs: outFaqs, menus: outMenus, truncated };
}

/** 回答の根拠になる情報が 1 つもない（店名以外の店舗情報・メニュー・FAQ がすべて空） */
export function isKnowledgeEmpty(k: Knowledge): boolean {
  return (
    k.faqs.length === 0 &&
    k.menus.length === 0 &&
    SHOP_KNOWLEDGE_FIELDS.every((f) => f === "shop_name" || k.shop[f] === "")
  );
}

/** 登録情報のすべての文章（電話番号・URL の照合用） */
export function knowledgeText(k: Knowledge): string {
  return [
    ...SHOP_KNOWLEDGE_FIELDS.map((f) => k.shop[f]),
    ...k.menus.flatMap((m) => [m.name, m.priceNote, m.description]),
    ...k.faqs.flatMap((f) => [f.question, f.answer]),
  ].join("\n");
}

export function isShopKnowledgeField(v: string): v is ShopKnowledgeField {
  return (SHOP_KNOWLEDGE_FIELDS as readonly string[]).includes(v);
}

/** 金額の表示（例：4400 → "4,400円"）。ロケールに依存しない */
export function formatYen(price: number): string {
  return `${String(price).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}円`;
}
