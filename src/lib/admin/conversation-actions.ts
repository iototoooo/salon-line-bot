import { type AnswerResult, generateAnswer } from "@/lib/ai/answer";
import type { AnswerModel } from "@/lib/ai/claude-model";
import { buildKnowledge } from "@/lib/ai/knowledge";
import { getShopSettings, listPublishedFaqs, listPublishedMenus } from "@/lib/db/shop";
import { DEFAULT_FALLBACK_MESSAGE } from "@/lib/line/process-events";
import { type ActionState, fail, ok, SAVE_FAILED } from "./action-state";
import type { AdminActionContext } from "./data-actions";
import { WRITE_DISABLED_MESSAGE } from "./mode";
import { resolveConversation } from "./repo";
import { validateId } from "./validation";

/**
 * 会話管理の操作（バッチ 3：対応済みにする・回答テスト）。Next.js に依存しない本体（テスト対象）。
 */

export async function markResolved(ctx: AdminActionContext, fd: FormData): Promise<ActionState> {
  if (!ctx.modes.writeEnabled) return fail(WRITE_DISABLED_MESSAGE);
  const id = validateId(fd);
  if (!id) return fail("対象が見つかりませんでした。画面を再読み込みしてください。");
  try {
    return (await resolveConversation(ctx.db, id, ctx.user.id))
      ? ok("対応済みにしました。")
      : fail("すでに対応済みか、対象が見つかりませんでした。画面を再読み込みしてください。");
  } catch {
    return fail(SAVE_FAILED);
  }
}

// ---------------------------------------------------------------------------
// 回答テスト（要件 F-27：LINE に送らず、管理画面で AI の回答を確認する）
// ---------------------------------------------------------------------------

/** 回答テストで AI を呼ぶ回数の上限（サーバーの 1 プロセスあたり・1 時間）。費用の暴走を防ぐ */
export const ANSWER_TEST_LIMIT_PER_HOUR = 20;
const answerTestCalls: number[] = [];

/** テスト用：回数の記録を消す */
export function resetAnswerTestLimiter() {
  answerTestCalls.length = 0;
}

function reserveAnswerTest(now: number): boolean {
  while (answerTestCalls.length && answerTestCalls[0] <= now - 3_600_000) answerTestCalls.shift();
  if (answerTestCalls.length >= ANSWER_TEST_LIMIT_PER_HOUR) return false;
  answerTestCalls.push(now);
  return true;
}

export type AnswerTestState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "done";
      question: string;
      aiCalled: boolean;
      result: Pick<AnswerResult, "status" | "replyText" | "needsOwner" | "category" | "code" | "reason" | "sources">;
      note: string | null;
    };

export type AnswerTestDeps = {
  /** null：AI を呼ばない（安全スイッチ OFF または API キー未設定） */
  model: AnswerModel | null;
  now?: () => number;
};

export async function runAnswerTest(ctx: AdminActionContext, fd: FormData, deps: AnswerTestDeps): Promise<AnswerTestState> {
  const question = String(fd.get("question") ?? "").replace(/\r\n?/g, "\n").trim();
  if (!question) return { status: "error", message: "質問を入力してください。" };

  let knowledge;
  let fallback = DEFAULT_FALLBACK_MESSAGE;
  try {
    const [shop, faqs, menus] = await Promise.all([getShopSettings(ctx.db), listPublishedFaqs(ctx.db), listPublishedMenus(ctx.db)]);
    knowledge = buildKnowledge(shop, faqs, menus);
    fallback = shop.fallback_message || DEFAULT_FALLBACK_MESSAGE;
  } catch {
    return { status: "error", message: "登録情報を読み込めませんでした。時間をおいて再度お試しください。" };
  }

  const now = deps.now ?? Date.now;
  let aiCalled = false;
  let limited = false;
  const result = await generateAnswer({
    question,
    knowledge,
    model: deps.model,
    errorMessage: fallback,
    // お客様の利用枠（reserve_ai_usage）は使わない（テストで本番の上限を消費しない）。代わりに回答テスト専用の上限
    reserveUsage: async () => {
      if (!reserveAnswerTest(now())) {
        limited = true;
        return "shop_daily_limit";
      }
      aiCalled = true;
      return "reserved";
    },
    now,
  });

  let note: string | null = null;
  if (!deps.model) note = "AI は呼び出していません（安全のための初期設定、または API キーが未設定）。AI を呼ぶ前の判定結果だけを表示しています。";
  else if (limited) note = `回答テストの上限（1 時間に ${ANSWER_TEST_LIMIT_PER_HOUR} 回）に達したため、AI は呼び出していません。`;

  return {
    status: "done",
    question,
    aiCalled,
    result: {
      status: result.status,
      replyText: result.replyText,
      needsOwner: result.needsOwner,
      category: result.category,
      code: result.code,
      reason: result.reason,
      sources: result.sources,
    },
    note,
  };
}
