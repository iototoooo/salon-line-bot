import type { FaqCategory, MenuCategory } from "@/types/database";

/**
 * 管理画面の入力チェック。DB の CHECK 制約（supabase/migrations/20261110000000_initial_schema.sql）と同じ条件にし、
 * 保存前に日本語のエラーを返す（DB のエラーをそのまま画面に出さない）。
 * 文字数は DB の char_length と同じく「文字（コードポイント）」で数える。
 */

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };

export const FAQ_CATEGORIES: ReadonlyArray<{ value: FaqCategory; label: string }> = [
  { value: "hours", label: "営業時間・定休日" },
  { value: "price", label: "料金" },
  { value: "reservation", label: "予約" },
  { value: "treatment", label: "施術" },
  { value: "access", label: "アクセス・駐車場" },
  { value: "other", label: "その他" },
];

export const MENU_CATEGORIES: ReadonlyArray<{ value: MenuCategory; label: string }> = [
  { value: "cut", label: "カット" },
  { value: "color", label: "カラー" },
  { value: "perm", label: "パーマ" },
  { value: "treatment", label: "トリートメント" },
  { value: "set", label: "セット" },
  { value: "other", label: "その他" },
];

export const LIMITS = {
  faqQuestion: 300,
  faqAnswer: 2000,
  menuName: 100,
  menuPriceNote: 200,
  menuDescription: 1000,
  menuPriceMax: 1_000_000,
  menuDurationMax: 600,
  sortOrderAbs: 100_000,
  shopName: 100,
  businessHours: 1000,
  regularHolidays: 500,
  address: 300,
  phone: 30,
  parking: 1000,
  reservationGuide: 1000,
  temporaryNotice: 1000,
  fallbackMessage: 500,
  /** LINE のテキストメッセージの上限 */
  broadcastBody: 5000,
} as const;

export const len = (s: string) => Array.from(s).length;

/** 前後の空白を除き、改行を \n にそろえる */
function text(fd: FormData, name: string): string {
  return String(fd.get(name) ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function checkLength(errors: Record<string, string>, name: string, value: string, max: number, required: boolean) {
  if (required && value === "") errors[name] = "入力してください。";
  else if (len(value) > max) errors[name] = `${max} 文字以内で入力してください（現在 ${len(value)} 文字）。`;
}

function integer(
  errors: Record<string, string>,
  name: string,
  raw: string,
  { min, max, required }: { min: number; max: number; required: boolean },
): number | null {
  if (raw === "") {
    if (required) errors[name] = "入力してください。";
    return null;
  }
  // 全角数字・カンマを受け付ける（料金の入力で多いため）
  const normalized = raw.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[,，]/g, "");
  if (!/^-?\d+$/.test(normalized)) {
    errors[name] = "半角の整数で入力してください。";
    return null;
  }
  const n = Number(normalized);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    errors[name] = `${min.toLocaleString("ja-JP")}〜${max.toLocaleString("ja-JP")} の範囲で入力してください。`;
    return null;
  }
  return n;
}

const bool = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return v === "on" || v === "true" || v === "1";
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateId(fd: FormData, name = "id"): string | null {
  const v = String(fd.get(name) ?? "");
  return UUID.test(v) ? v.toLowerCase() : null;
}

export type FaqInput = { question: string; answer: string; category: FaqCategory; is_published: boolean; sort_order: number };

export function validateFaq(fd: FormData): Validated<FaqInput> {
  const errors: Record<string, string> = {};
  const question = text(fd, "question");
  const answer = text(fd, "answer");
  checkLength(errors, "question", question, LIMITS.faqQuestion, true);
  checkLength(errors, "answer", answer, LIMITS.faqAnswer, true);
  const category = String(fd.get("category") ?? "") as FaqCategory;
  if (!FAQ_CATEGORIES.some((c) => c.value === category)) errors.category = "分類を選んでください。";
  const sort = integer(errors, "sort_order", text(fd, "sort_order"), {
    min: -LIMITS.sortOrderAbs,
    max: LIMITS.sortOrderAbs,
    required: false,
  });
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { question, answer, category, is_published: bool(fd, "is_published"), sort_order: sort ?? 0 } };
}

export type MenuInput = {
  name: string;
  category: MenuCategory;
  price: number;
  price_note: string;
  duration_min: number | null;
  description: string;
  is_published: boolean;
  sort_order: number;
};

export function validateMenu(fd: FormData): Validated<MenuInput> {
  const errors: Record<string, string> = {};
  const name = text(fd, "name");
  const price_note = text(fd, "price_note");
  const description = text(fd, "description");
  checkLength(errors, "name", name, LIMITS.menuName, true);
  checkLength(errors, "price_note", price_note, LIMITS.menuPriceNote, false);
  checkLength(errors, "description", description, LIMITS.menuDescription, false);
  const category = String(fd.get("category") ?? "") as MenuCategory;
  if (!MENU_CATEGORIES.some((c) => c.value === category)) errors.category = "分類を選んでください。";
  const price = integer(errors, "price", text(fd, "price"), { min: 0, max: LIMITS.menuPriceMax, required: true });
  const duration = integer(errors, "duration_min", text(fd, "duration_min"), {
    min: 1,
    max: LIMITS.menuDurationMax,
    required: false,
  });
  const sort = integer(errors, "sort_order", text(fd, "sort_order"), {
    min: -LIMITS.sortOrderAbs,
    max: LIMITS.sortOrderAbs,
    required: false,
  });
  if (Object.keys(errors).length || price === null) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      category,
      price,
      price_note,
      duration_min: duration,
      description,
      is_published: bool(fd, "is_published"),
      sort_order: sort ?? 0,
    },
  };
}

export type ShopInfoInput = {
  shop_name: string;
  business_hours: string;
  regular_holidays: string;
  address: string;
  phone: string;
  parking: string;
  reservation_guide: string;
  temporary_notice: string;
  fallback_message: string;
};

const SHOP_FIELDS: ReadonlyArray<[keyof ShopInfoInput, number, boolean]> = [
  ["shop_name", LIMITS.shopName, false],
  ["business_hours", LIMITS.businessHours, false],
  ["regular_holidays", LIMITS.regularHolidays, false],
  ["address", LIMITS.address, false],
  ["phone", LIMITS.phone, false],
  ["parking", LIMITS.parking, false],
  ["reservation_guide", LIMITS.reservationGuide, false],
  ["temporary_notice", LIMITS.temporaryNotice, false],
  ["fallback_message", LIMITS.fallbackMessage, true],
];

export function validateShopInfo(fd: FormData): Validated<ShopInfoInput> {
  const errors: Record<string, string> = {};
  const value = {} as ShopInfoInput;
  for (const [name, max, required] of SHOP_FIELDS) {
    const v = text(fd, name);
    checkLength(errors, name, v, max, required);
    value[name] = v;
  }
  if (value.phone && !/^[0-9０-９+＋()（）\-－ー‐ 　]+$/.test(value.phone)) {
    errors.phone = "電話番号は数字・ハイフン・括弧で入力してください。";
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}

/** 自動応答 ON/OFF の変更。誤操作を防ぐため確認の文言（「変更する」）を必須にする */
export const BOT_TOGGLE_CONFIRMATION = "変更する";

export function validateBotToggle(fd: FormData): Validated<{ bot_enabled: boolean }> {
  const target = String(fd.get("bot_enabled") ?? "");
  if (target !== "true" && target !== "false") return { ok: false, errors: { bot_enabled: "変更内容が不正です。" } };
  if (text(fd, "confirmation") !== BOT_TOGGLE_CONFIRMATION) {
    return { ok: false, errors: { confirmation: `確認のため「${BOT_TOGGLE_CONFIRMATION}」と入力してください。` } };
  }
  return { ok: true, value: { bot_enabled: target === "true" } };
}

/** オーナー通知先（LINE ユーザー ID）。空欄なら解除。前後の空白・全角は受け付けない */
export function validateOwnerLineUserId(fd: FormData): Validated<{ owner_line_user_id: string | null }> {
  const raw = text(fd, "owner_line_user_id");
  if (bool(fd, "clear")) return { ok: true, value: { owner_line_user_id: null } };
  if (raw === "") return { ok: false, errors: { owner_line_user_id: "LINE ユーザー ID を入力してください（解除する場合はチェックを入れてください）。" } };
  if (!/^U[0-9a-f]{32}$/.test(raw)) {
    return {
      ok: false,
      errors: { owner_line_user_id: "形式が正しくありません（U で始まる 33 文字。LINE Developers の「あなたのユーザーID」）。" },
    };
  }
  return { ok: true, value: { owner_line_user_id: raw } };
}

export function validateBroadcastBody(fd: FormData): Validated<{ body: string }> {
  const errors: Record<string, string> = {};
  const body = text(fd, "body");
  checkLength(errors, "body", body, LIMITS.broadcastBody, true);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { body } };
}

/** 本配信の確認文言（要件 F-36） */
export const BROADCAST_CONFIRMATION = "配信する";
