import { type AnswerResult, generateAnswer } from "@/lib/ai/answer";
import { type AnswerModel, CLAUDE_CALL_LIMITS } from "@/lib/ai/claude-model";
import { maskPersonalInfo } from "@/lib/ai/guard";
import { buildKnowledge } from "@/lib/ai/knowledge";
import type { AiUsageLimiter } from "@/lib/ai/usage-limit";
import { REPLY_WINDOW_MS } from "@/lib/line/event-store";
import {
  DEFAULT_FALLBACK_MESSAGE,
  type Logger,
  NON_TEXT_REPLY,
  type ReplyDeliveryOutcome,
  type Responder,
  type ResponderResult,
} from "@/lib/line/process-events";
import type { LineNonTextMessageEvent, LineTextMessage, LineTextMessageEvent } from "@/lib/line/types";
import type { ConversationInsert, FaqRow, MenuRow, ShopSettingsRow } from "@/types/database";

/**
 * AI 応答の Responder（LINE_RESPONDER=ai のときに使用）。
 *
 * 流れ：店舗情報を取得 → 自動応答 OFF なら定型文のみ（AI は呼ばない）→ テキスト以外は定型文
 *       → FAQ・メニューを取得 → generateAnswer（AI＋コード側の検証）→ 返信後に会話ログを保存
 *
 * - 店舗情報・FAQ・メニューは毎回 DB から取得する（料金の変更が再デプロイなしで反映される。AC-08）
 * - 会話ログの保存に失敗しても返信は止めない（ログには個人情報を出さない）
 * - オーナーへの LINE 通知は Responder では送らない（needs_owner として記録し、返信後に process-events から
 *   src/lib/notify/owner-notifier.ts がまとめて送る。WBS 2.5）
 */

export type AiResponderDeps = {
  loadShopSettings: () => Promise<ShopSettingsRow>;
  loadFaqs: () => Promise<FaqRow[]>;
  loadMenus: () => Promise<MenuRow[]>;
  /** 会話ログを保存する（line_event_id で冪等） */
  saveConversation: (row: ConversationInsert) => Promise<unknown>;
  /** null：ANTHROPIC_API_KEY 未設定（AI を呼ばずエラー扱いの定型文） */
  model: AnswerModel | null;
  /** Claude API の利用回数制限（AI を呼び出す直前に利用枠を確保する） */
  usageLimiter: AiUsageLimiter;
  logger: Logger;
  now?: () => number;
};

const LINE_USER_ID = /^U[0-9a-f]{32}$/;
const MAX_TEXT = 5000;
const MAX_ERROR = 1000;
const MAX_REASON = 300;

type Decision = Omit<AnswerResult, "status"> & {
  status: AnswerResult["status"] | "bot_off" | "unsupported";
};

/**
 * AI を呼ぶために必要な残り時間。返信期限（受信後 50 秒）までにこれより短ければ AI を呼ばず定型文にする
 * （AI の呼び出しが間に合わず、費用だけかかって返信できない事態を避ける）。
 * Claude のタイムアウト 15 秒＋DB 取得・返信の余裕。
 */
export const MIN_TIME_FOR_AI_MS = CLAUDE_CALL_LIMITS.timeoutMs + 5_000;

export function createAiResponder(deps: AiResponderDeps): Responder {
  return async (event) => {
    const decision = await decide(event, deps);
    const result: ResponderResult = {
      messages: [{ type: "text", text: decision.replyText }],
      needsOwnerNotification: decision.needsOwner,
      // 店舗全体の AI 利用上限に達した：一般のお客様全員が定型文になるため、すぐに知らせる（DB 側で 1 日 1 回）
      urgentOwnerNotification: decision.code === "usage_shop_daily_limit",
      afterReply: (delivery, sent) => saveLog(event, decision, delivery, sent, deps),
    };
    return result;
  };
}

async function decide(event: LineTextMessageEvent | LineNonTextMessageEvent, deps: AiResponderDeps): Promise<Decision> {
  const id = event.webhookEventId;

  let shop: ShopSettingsRow;
  try {
    shop = await deps.loadShopSettings();
  } catch (err) {
    deps.logger.error(`[bot] failed to load shop settings, event=${id}`, summary(err));
    return fixed("error", DEFAULT_FALLBACK_MESSAGE, true, "shop_settings_unavailable");
  }

  // 自動応答 OFF（緊急停止）：AI を呼ばず、店舗の定型文だけを返す（F-06 / AC-09）
  if (!shop.bot_enabled) {
    return fixed("bot_off", shop.fallback_message || DEFAULT_FALLBACK_MESSAGE, true, null);
  }

  // テキスト以外（画像・スタンプなど）は AI に渡さない（F-05 / AC-07）
  if (event.kind !== "text") {
    return fixed("unsupported", NON_TEXT_REPLY, true, null);
  }

  let faqs: FaqRow[];
  let menus: MenuRow[];
  try {
    [faqs, menus] = await Promise.all([deps.loadFaqs(), deps.loadMenus()]);
  } catch (err) {
    deps.logger.error(`[bot] failed to load faqs/menus, event=${id}`, summary(err));
    return fixed("error", shop.fallback_message || DEFAULT_FALLBACK_MESSAGE, true, "knowledge_unavailable");
  }

  const knowledge = buildKnowledge(shop, faqs, menus);
  if (knowledge.truncated) deps.logger.warn(`[bot] knowledge truncated to fit the prompt limit, event=${id}`);

  // 返信期限までの残り時間が足りなければ AI を呼ばない（1 回の Webhook に複数イベントがある場合など）
  const remaining = event.timestamp + REPLY_WINDOW_MS - (deps.now ?? Date.now)();
  const enoughTime = remaining >= MIN_TIME_FOR_AI_MS;
  if (!enoughTime) deps.logger.warn(`[bot] not enough time before the reply deadline; skipping AI, event=${id}`);

  const userId = event.source.type === "user" ? event.source.userId : null;
  const answer = await generateAnswer({
    question: event.text,
    knowledge,
    model: enoughTime ? deps.model : null,
    errorMessage: shop.fallback_message || DEFAULT_FALLBACK_MESSAGE,
    // 利用枠は同じ webhookEventId で 1 回だけ確保される（DB 側で重複を判定）。
    // ユーザー ID を確認できない場合は例外にし、AI を呼ばない
    reserveUsage: async () => {
      if (!userId || !LINE_USER_ID.test(userId)) throw new Error("usage: unexpected source");
      return deps.usageLimiter.reserve({ webhookEventId: id, lineUserId: userId });
    },
    now: deps.now,
  });
  if (!enoughTime && answer.code === "ai_not_configured") answer.code = "reply_deadline_too_close";
  // 本文・userId はログに出さない。状態と結果コードだけ
  deps.logger.info(`[bot] answer status=${answer.status} code=${answer.code ?? "-"} event=${id}`);
  return answer;
}

async function saveLog(
  event: LineTextMessageEvent | LineNonTextMessageEvent,
  d: Decision,
  delivery: ReplyDeliveryOutcome,
  sent: LineTextMessage[],
  deps: AiResponderDeps,
): Promise<void> {
  const id = event.webhookEventId;
  const userId = event.source.type === "user" ? event.source.userId : null;
  if (!userId || !LINE_USER_ID.test(userId)) {
    deps.logger.warn(`[bot] conversation not saved: unexpected source, event=${id}`);
    return;
  }

  const delivered = delivery === "sent";
  const replyFailed = delivery === "failed" || delivery === "unknown" || delivery === "not_sent";
  const codes = [d.code, replyFailed ? `reply_${delivery}` : null].filter(Boolean).join(" ");

  const row: ConversationInsert = {
    line_event_id: id,
    line_user_id: userId,
    message_type: event.kind === "text" ? "text" : event.messageType.slice(0, 30) || "unknown",
    user_message: event.kind === "text" ? event.text.slice(0, MAX_TEXT) : null,
    ai_status: d.status,
    ai_category: d.category,
    // 実際に送った（送ろうとした）文。Responder の返信を定型文に置き換えた場合もそちらを記録する
    bot_reply: (sent.length > 0 ? sent.map((m) => m.text).join("\n") : d.replyText).slice(0, MAX_TEXT),
    // dry-run（simulated）・送信失敗は実際には届いていないため none
    reply_method: delivered ? "reply" : "none",
    needs_owner: d.needsOwner || replyFailed,
    model: d.model,
    input_tokens: d.inputTokens,
    output_tokens: d.outputTokens,
    latency_ms: d.latencyMs,
    error_message: codes ? codes.slice(0, MAX_ERROR) : null,
    source_faq_ids: d.sources.faqIds,
    source_menu_ids: d.sources.menuIds,
    source_shop_fields: d.sources.shopFields,
    // AI の自由記述のため、電話番号・メールアドレス等を伏せてから保存する
    ai_reason: d.reason ? maskPersonalInfo(d.reason).slice(0, MAX_REASON) : null,
  };
  try {
    await deps.saveConversation(row);
  } catch (err) {
    deps.logger.error(`[bot] failed to save conversation, event=${id}`, summary(err));
  }
}

function fixed(status: Decision["status"], replyText: string, needsOwner: boolean, code: string | null): Decision {
  return {
    status,
    replyText,
    needsOwner,
    category: null,
    sources: { faqIds: [], menuIds: [], shopFields: [] },
    reason: null,
    code,
    model: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
  };
}

function summary(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : "unknown error";
}
