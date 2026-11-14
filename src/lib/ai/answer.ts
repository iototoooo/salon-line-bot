import type { AiStatus, FaqCategory, ShopKnowledgeField } from "@/types/database";
import { AnswerModelError, type AnswerModel } from "./claude-model";
import { asksAvailability, asksReservationChange, checkAnsweredDraft, type GuardFailure } from "./guard";
import { isKnowledgeEmpty, isShopKnowledgeField, type Knowledge } from "./knowledge";
import { AI_OUTPUT_SCHEMA, type AiDraft, parseAiOutput } from "./output";
import { renderCustomerMessage, renderKnowledge, SYSTEM_RULES } from "./prompt";
import { type UsageReservation, usageBlockPolicy } from "./usage-limit";

/**
 * お客様の質問 1 件に対する返信内容を決める（AI 呼び出し＋コード側の検証）。
 *
 * 返信の種類
 *   answered       : AI の回答（コード側の検証に合格したものだけ）
 *   cannot_answer  : 「確認が必要です」の定型文＋オーナー対応（AI が回答不能と判断、または検証で不採用）
 *   reservation    : 予約方法の案内（AI の文章は使わず、登録された予約方法からコードで組み立てる）
 *   error          : AI 呼び出しの失敗・不正な出力。店舗の定型文＋オーナー対応
 */

export const CONFIRMATION_NEEDED_MESSAGE =
  "お問い合わせありがとうございます。こちらの内容は確認が必要です。担当者が確認のうえ、改めてご連絡いたします。";

export const RESERVATION_INTRO = "ご予約の空き状況の確認やご予約の確定は、こちらの自動応答ではお受けできません。";

/** これより長い質問は AI に渡さない（費用の上限・異常な入力の対策） */
export const MAX_QUESTION_CHARS = 1000;

export type AnswerStatus = Extract<AiStatus, "answered" | "cannot_answer" | "reservation" | "error">;

export type AnswerSources = {
  faqIds: string[];
  menuIds: string[];
  shopFields: ShopKnowledgeField[];
};

export type AnswerResult = {
  status: AnswerStatus;
  replyText: string;
  needsOwner: boolean;
  category: FaqCategory | null;
  sources: AnswerSources;
  /** AI の判定理由（オーナー確認用） */
  reason: string | null;
  /** 個人情報を含まない処理結果コード（例 guard_unregistered_price, ai_timeout） */
  code: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** AI を呼び出した場合のみ */
  latencyMs: number | null;
};

export type GenerateAnswerInput = {
  question: string;
  knowledge: Knowledge;
  /** null の場合は API キー未設定（AI を呼ばずエラー扱い） */
  model: AnswerModel | null;
  /** AI 処理エラー時に返す店舗の定型文（shop_settings.fallback_message） */
  errorMessage: string;
  /**
   * AI を呼び出す直前に利用枠を確保する（回数制限）。'reserved' 以外・例外のときは AI を呼ばない。
   * 省略できない（回数制限なしで AI を呼べないようにするため）。
   */
  reserveUsage: () => Promise<UsageReservation>;
  now?: () => number;
};

const NO_SOURCES: AnswerSources = { faqIds: [], menuIds: [], shopFields: [] };

export async function generateAnswer(input: GenerateAnswerInput): Promise<AnswerResult> {
  const { knowledge, model } = input;
  const now = input.now ?? Date.now;
  const question = input.question.trim();

  // 1. AI を呼ぶ前の判定（費用をかけない）
  if (!question) return cannotAnswer("empty_question");
  if (question.length > MAX_QUESTION_CHARS) return cannotAnswer("question_too_long");
  if (isKnowledgeEmpty(knowledge)) {
    // 根拠が 1 つもない状態で AI に答えさせない
    return cannotAnswer("no_knowledge");
  }
  if (!model) return error(input.errorMessage, "ai_not_configured", null);

  // 2. 利用枠の確保（AI を呼び出す直前。確認できない場合は安全側に倒して AI を呼ばない）
  let quota: UsageReservation;
  try {
    quota = await input.reserveUsage();
  } catch {
    return usageBlocked("check_failed");
  }
  if (quota !== "reserved") return usageBlocked(quota);

  // 3. AI 呼び出し
  const started = now();
  let response;
  try {
    response = await model.generate({
      system: SYSTEM_RULES,
      knowledge: renderKnowledge(knowledge),
      user: renderCustomerMessage(question),
      schema: AI_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    });
  } catch (err) {
    const code = err instanceof AnswerModelError ? err.code : "unknown";
    return { ...error(input.errorMessage, `ai_${code}`, model.model), latencyMs: now() - started };
  }
  const usage = {
    model: response.model || model.model,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    latencyMs: now() - started,
  };

  if (response.stopReason !== "end_turn") {
    // max_tokens（途中で切れた JSON）・refusal など
    return { ...error(input.errorMessage, `ai_stop_${response.stopReason ?? "unknown"}`, null), ...usage };
  }
  const parsed = response.text === null ? null : parseAiOutput(response.text);
  if (!parsed || !parsed.ok) {
    return { ...error(input.errorMessage, `ai_${parsed ? parsed.error : "empty_output"}`, null), ...usage };
  }
  const draft = parsed.draft;

  // 4. AI の判定をそのまま信用せず、コード側で最終判定する
  if (draft.status === "reservation") return { ...reservation(question, knowledge, draft, null), ...usage };
  if (draft.status === "cannot_answer") {
    return { ...cannotAnswer(null, draft.reason || null, draft.category), ...usage };
  }

  // answered：空き状況などを尋ねる質問には AI の回答を使わない
  if (asksAvailability(question)) {
    return { ...reservation(question, knowledge, draft, "forced_reservation"), ...usage };
  }
  const guard = checkAnsweredDraft(draft, knowledge);
  if (!guard.ok) {
    if (guard.reason === "availability_claim") {
      return { ...reservation(question, knowledge, draft, "guard_availability_claim"), ...usage };
    }
    return { ...cannotAnswer(`guard_${guard.reason satisfies GuardFailure}`, null, draft.category), ...usage };
  }

  return {
    status: "answered",
    replyText: draft.answer.trim(),
    needsOwner: false,
    category: draft.category,
    sources: toSources(draft, knowledge),
    reason: null,
    code: null,
    ...usage,
  };
}

/** 予約の案内。AI の文章は使わず、登録された予約方法（なければ電話番号）だけで組み立てる */
function reservation(question: string, k: Knowledge, draft: AiDraft, code: string | null): AnswerResult {
  const change = asksReservationChange(question);
  const reason = draft.reason || null;
  let guide: string | null = null;
  let field: ShopKnowledgeField | null = null;
  if (k.shop.reservation_guide) {
    guide = k.shop.reservation_guide;
    field = "reservation_guide";
  } else if (k.shop.phone) {
    guide = `ご予約はお電話（${k.shop.phone}）で承っております。`;
    field = "phone";
  }
  if (!guide || !field) {
    // 案内できる予約方法が登録されていない
    return {
      ...cannotAnswer(code ?? "no_reservation_guide", reason, "reservation"),
      status: "reservation",
    };
  }
  return {
    status: "reservation",
    replyText: change
      ? `${RESERVATION_INTRO}\n${guide}\n変更・キャンセルについては、担当者からも確認のご連絡をいたします。`
      : `${RESERVATION_INTRO}\n${guide}`,
    // 予約の変更・キャンセルはオーナーの対応が必要（設計書 6.1）
    needsOwner: change,
    category: "reservation",
    sources: { faqIds: [], menuIds: [], shopFields: [field] },
    reason,
    code,
    model: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
  };
}

function cannotAnswer(code: string | null, reason: string | null = null, category: FaqCategory | null = null): AnswerResult {
  return {
    status: "cannot_answer",
    replyText: CONFIRMATION_NEEDED_MESSAGE,
    needsOwner: true,
    category,
    sources: NO_SOURCES,
    reason,
    code,
    model: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
  };
}

/**
 * 回数制限で AI を呼ばなかった場合。定型文で返信する（お客様への返信を途切れさせない）。
 * 状態は error（AI の判断ではなく、システム側の理由で回答しなかったもの）。code（usage_*）で理由を区別する。
 * オーナー対応にするかは理由ごとに決める（usageBlockPolicy）。
 */
function usageBlocked(reason: Parameters<typeof usageBlockPolicy>[0]): AnswerResult {
  const policy = usageBlockPolicy(reason);
  return {
    status: "error",
    replyText: policy.message,
    needsOwner: policy.needsOwner,
    category: null,
    sources: NO_SOURCES,
    reason: null,
    code: `usage_${reason}`,
    model: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
  };
}

function error(message: string, code: string, model: string | null): AnswerResult {
  return {
    status: "error",
    replyText: message,
    needsOwner: true,
    category: null,
    sources: NO_SOURCES,
    reason: null,
    code,
    model,
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
  };
}

/** 参照 ID（F1 / M1 / S:phone）を実際の ID・項目名に変換する（検証済みの draft のみ） */
function toSources(draft: AiDraft, k: Knowledge): AnswerSources {
  return {
    faqIds: draft.faq_refs.flatMap((r) => k.faqs.filter((f) => f.ref === r).map((f) => f.id)),
    menuIds: draft.menu_refs.flatMap((r) => k.menus.filter((m) => m.ref === r).map((m) => m.id)),
    shopFields: draft.shop_refs.flatMap((r) => {
      const f = r.slice(2);
      return isShopKnowledgeField(f) ? [f] : [];
    }),
  };
}
