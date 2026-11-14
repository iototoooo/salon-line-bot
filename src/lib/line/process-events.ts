import { LineApiError, type LineReplyClient } from "./client";
import type { ReplyResult, WebhookEventStore } from "./event-store";
import type { LineNonTextMessageEvent, LineTextMessage, LineTextMessageEvent, LineWebhookEvent } from "./types";

export type Logger = Pick<Console, "info" | "warn" | "error">;

/** 返信の結果。not_sent: 返信期限切れ・予約失敗などで送信しなかった */
export type ReplyDeliveryOutcome = ReplyResult | "not_sent";

/** Responder が返信内容に加えて返せる情報（AI 応答で使用。Echo は配列だけを返す） */
export type ResponderResult = {
  messages: LineTextMessage[];
  /** オーナー通知の対象にする（line_webhook_events.needs_owner_notification に記録） */
  needsOwnerNotification?: boolean;
  /** オーナー通知を間隔・1 日の上限にかかわらず送る（店舗全体の AI 利用上限に達したとき。DB 側で 1 日 1 回に制限） */
  urgentOwnerNotification?: boolean;
  /**
   * 返信を試みた後に呼ばれる（会話ログの保存など）。例外は捕捉してログに残すだけで、返信には影響させない。
   * Responder 自体が失敗した場合（定型文で返信）は呼ばれない。
   */
  afterReply?: (delivery: ReplyDeliveryOutcome, sentMessages: LineTextMessage[]) => Promise<void>;
};

/** メッセージイベントに対する返信内容を決める（Echo / AI 応答を差し替え可能） */
export type Responder = (
  event: LineTextMessageEvent | LineNonTextMessageEvent,
) => Promise<LineTextMessage[] | ResponderResult>;

export type ProcessDeps = {
  store: WebhookEventStore;
  client: LineReplyClient;
  respond: Responder;
  /** 処理中にエラーが起きたとき、まだ返信していなければ送る定型文 */
  fallbackMessage: string;
  logger: Logger;
  now?: () => number;
  /**
   * オーナー通知（WBS 2.5）。すべてのイベントの返信と処理状態の記録が終わった後に 1 回だけ呼ぶ。
   * 例外は捕捉してログに残すだけ（お客様への返信には影響させない）。未設定なら通知しない。
   */
  notifyOwner?: (options: { urgent: boolean }) => Promise<unknown>;
};

export type EventOutcome =
  | "replied"
  /** dry-run：返信処理は完了したが LINE へは送信していない */
  | "simulated"
  | "duplicate"
  | "skipped"
  | "failed"
  | "failed_fallback_replied"
  /** 返信期限切れ・返信済みのため返信しなかった */
  | "reply_not_allowed"
  | "store_error";

/** LINE テキストメッセージの最大文字数（LINE 仕様：5,000 文字） */
export const MAX_TEXT_LENGTH = 5000;
/** 1 回の返信で送れるメッセージ数の上限（LINE 仕様で 5 件と想定・要確認） */
export const MAX_MESSAGES_PER_REPLY = 5;

export const NON_TEXT_REPLY =
  "画像やスタンプなどには自動でお答えできません。お手数ですが、文章でお問い合わせください。";

export const DEFAULT_FALLBACK_MESSAGE =
  "お問い合わせありがとうございます。担当者が確認して、改めてご連絡いたします。";

/** この時間を超えた古いイベントは警告ログを出す（返信可否はストアの返信期限で判定） */
const REPLY_TOKEN_WARN_AGE_MS = 30_000;

/** ローカル検証用の Echo 応答 */
export const echoResponder: Responder = async (event) => {
  if (event.kind === "text") {
    return [{ type: "text", text: `【テスト応答】${event.text}` }];
  }
  return [{ type: "text", text: NON_TEXT_REPLY }];
};

export type ClaimEventsResult = {
  /** 処理権を取得できた（＝このリクエストで処理すべき）イベント */
  claimed: LineWebhookEvent[];
  /** 記録に失敗した場合のエラー。以降のイベントは未記録 */
  error?: unknown;
};

/**
 * Webhook 応答（2xx）を返す前に、イベントの処理権を取得する。
 * LINE の再送は 2xx 応答後の失敗を回復しないため、記録できなかった場合は error を返し、
 * 呼び出し側で 2xx 以外を返す。それまでに取得できたイベントは claimed に含まれ、処理してよい
 * （再送時には重複として除外される）。
 */
export async function claimEvents(
  events: LineWebhookEvent[],
  store: WebhookEventStore,
  logger: Logger,
): Promise<ClaimEventsResult> {
  const claimed: LineWebhookEvent[] = [];
  for (const event of events) {
    let ok: boolean;
    try {
      ok = await store.claim({
        webhookEventId: event.webhookEventId,
        eventType: eventTypeOf(event),
        isRedelivery: event.isRedelivery,
        eventTimestamp: event.timestamp,
      });
    } catch (error) {
      return { claimed, error };
    }
    if (ok) claimed.push(event);
    else {
      logger.info(
        `[line:webhook] duplicate event ignored, event=${event.webhookEventId} redelivery=${event.isRedelivery}`,
      );
    }
  }
  return { claimed };
}

/**
 * 署名検証済みのイベントを 1 件ずつ処理する。
 * 1 件の失敗が他のイベントに影響しないよう、イベント単位で例外を捕捉する。
 * ログには個人情報（userId・本文）を出さない。
 *
 * options.alreadyClaimed: claimEvents で処理権を取得済みの場合は true（再度 claim しない）
 */
export async function processEvents(
  events: LineWebhookEvent[],
  deps: ProcessDeps,
  options: { alreadyClaimed?: boolean } = {},
): Promise<EventOutcome[]> {
  const outcomes: EventOutcome[] = [];
  const ctx: ProcessContext = { urgentOwnerNotification: false };
  for (const event of events) {
    outcomes.push(await processEvent(event, deps, options.alreadyClaimed ?? false, ctx));
  }
  // 通知は全イベントの返信の後に 1 回だけ（push の待ち時間で後続イベントの返信期限を削らない）。
  // 返信を試みたイベントがあるときだけ呼ぶ（重複・対象外のイベントだけなら新しい要対応はない）
  if (deps.notifyOwner && outcomes.some((o) => o !== "duplicate" && o !== "skipped")) {
    try {
      await deps.notifyOwner({ urgent: ctx.urgentOwnerNotification });
    } catch (err) {
      deps.logger.error("[line:webhook] owner notification failed", errorSummary(err));
    }
  }
  return outcomes;
}

type ProcessContext = { urgentOwnerNotification: boolean };

async function processEvent(
  event: LineWebhookEvent,
  deps: ProcessDeps,
  alreadyClaimed: boolean,
  ctx: ProcessContext,
): Promise<EventOutcome> {
  const { store, client, logger } = deps;
  const id = event.webhookEventId;

  // 1. 重複判定（処理権の取得）
  if (!alreadyClaimed) {
    let claimed: boolean;
    try {
      claimed = await store.claim({
        webhookEventId: id,
        eventType: eventTypeOf(event),
        isRedelivery: event.isRedelivery,
        eventTimestamp: event.timestamp,
      });
    } catch (err) {
      // 重複を判定できない場合は二重返信を避けるため処理しない（フェイルクローズ）
      logger.error(`[line:webhook] event store unavailable, event=${id}`, errorSummary(err));
      return "store_error";
    }
    if (!claimed) {
      logger.info(`[line:webhook] duplicate event ignored, event=${id} redelivery=${event.isRedelivery}`);
      return "duplicate";
    }
  }

  // 2. 返信対象外のイベント
  const skipReason = getSkipReason(event);
  if (skipReason) {
    logger.info(`[line:webhook] event skipped (${skipReason}), event=${id}`);
    await finishSafely(deps, id, "skipped");
    return "skipped";
  }
  const messageEvent = event as LineTextMessageEvent | LineNonTextMessageEvent;

  const age = (deps.now ?? Date.now)() - event.timestamp;
  if (age > REPLY_TOKEN_WARN_AGE_MS) {
    logger.warn(`[line:webhook] event is ${Math.round(age / 1000)}s old; reply token may be expired, event=${id}`);
  }

  // 3. 返信内容の生成（Echo / AI 応答）
  let response: ResponderResult | null = null;
  try {
    const r = await deps.respond(messageEvent);
    response = Array.isArray(r) ? { messages: r } : r;
  } catch (err) {
    logger.error(`[line:webhook] failed to build reply, event=${id}`, errorSummary(err));
  }
  const usingFallback = !response || !Array.isArray(response.messages) || response.messages.length === 0;
  const toSend = normalizeMessages(
    !response || usingFallback ? [{ type: "text", text: deps.fallbackMessage }] : response.messages,
  );
  const needsOwnerNotification = response?.needsOwnerNotification === true;
  if (needsOwnerNotification && response?.urgentOwnerNotification === true) ctx.urgentOwnerNotification = true;
  // 会話ログには、実際に送った（送ろうとした）文を渡す（Responder の返信が空で定型文に置き換えた場合も一致させる）
  const after = (delivery: ReplyDeliveryOutcome) => afterReplySafely(deps, id, response, delivery, toSend);

  // 4. 返信トークンの予約（1 回のみ・期限内のみ）
  let allowed: boolean;
  try {
    allowed = await store.beginReply(id);
  } catch (err) {
    // 使用状況を記録できないまま送ると二重送信を防げないため、送らない
    logger.error(`[line:webhook] could not reserve reply, event=${id}`, errorSummary(err));
    await after("not_sent");
    await finishSafely(deps, id, "failed", { error: "reply_reservation_failed", needsOwnerNotification: true });
    return "store_error";
  }
  if (!allowed) {
    logger.warn(`[line:webhook] reply not allowed (expired or already used), event=${id}`);
    await after("not_sent");
    await finishSafely(deps, id, "failed", { error: "reply_window_closed", needsOwnerNotification: true });
    return "reply_not_allowed";
  }

  // 5. 返信
  let delivered: ReplyResult;
  try {
    const delivery = await client.reply(messageEvent.replyToken, toSend);
    // 想定外の戻り値は送信成功とみなさない（成否不明として扱う）
    delivered = delivery === "sent" || delivery === "simulated" ? delivery : "unknown";
  } catch (err) {
    // 返信トークンは 1 回のみ使用可能。成否にかかわらず同じトークンで再送しない
    const result = classifyReplyError(err);
    logger.error(`[line:webhook] reply ${result}, event=${id}`, errorSummary(err));
    await recordReplySafely(deps, id, result);
    await after(result);
    await finishSafely(deps, id, "failed", { error: `reply_${result}`, needsOwnerNotification: true });
    return "failed";
  }
  await recordReplySafely(deps, id, delivered);
  await after(delivered);
  if (delivered === "unknown") {
    logger.error(`[line:webhook] reply client returned an unexpected result, event=${id}`);
    await finishSafely(deps, id, "failed", { error: "reply_unknown", needsOwnerNotification: true });
    return "failed";
  }

  if (usingFallback) {
    await finishSafely(deps, id, "failed", { error: "responder_failed", needsOwnerNotification: true });
    return "failed_fallback_replied";
  }
  await finishSafely(deps, id, "done", needsOwnerNotification ? { needsOwnerNotification: true } : undefined);
  return delivered === "simulated" ? "simulated" : "replied";
}

/** 返信後の処理（会話ログの保存など）。失敗しても返信・処理状態の記録には影響させない */
async function afterReplySafely(
  deps: ProcessDeps,
  id: string,
  response: ResponderResult | null,
  delivery: ReplyDeliveryOutcome,
  sentMessages: LineTextMessage[],
) {
  if (!response?.afterReply) return;
  try {
    await response.afterReply(delivery, sentMessages);
  } catch (err) {
    deps.logger.error(`[line:webhook] after-reply task failed, event=${id}`, errorSummary(err));
  }
}

/**
 * 返信 API の失敗を分類する。
 * - LINE が 4xx で拒否 → 未送信（failed）
 * - 5xx・タイムアウト・通信エラー → 届いたか不明（unknown）。二重送信を避けるため再送しない
 */
export function classifyReplyError(err: unknown): "failed" | "unknown" {
  if (err instanceof LineApiError && err.status >= 400 && err.status < 500) return "failed";
  return "unknown";
}

function normalizeMessages(messages: LineTextMessage[]): LineTextMessage[] {
  return messages
    .slice(0, MAX_MESSAGES_PER_REPLY)
    .map((m) => ({ type: "text" as const, text: m.text.slice(0, MAX_TEXT_LENGTH) }));
}

function eventTypeOf(event: LineWebhookEvent): string {
  return event.kind === "other" ? event.eventType : "message";
}

function getSkipReason(event: LineWebhookEvent): string | null {
  if (event.kind === "other") return `type=${event.eventType}`;
  if (event.mode !== "active") return `mode=${event.mode}`;
  if (event.source.type !== "user") return `source=${event.source.type}`;
  return null;
}

async function finishSafely(
  deps: ProcessDeps,
  id: string,
  status: "done" | "skipped" | "failed",
  options?: { error?: string; needsOwnerNotification?: boolean },
) {
  try {
    await deps.store.finish(id, status, options);
  } catch (err) {
    // 記録できなかったイベントは processing のまま残り、停止検出（markStalled）で拾われる
    deps.logger.error(`[line:webhook] failed to record status=${status}, event=${id}`, errorSummary(err));
  }
}

async function recordReplySafely(deps: ProcessDeps, id: string, result: ReplyResult) {
  try {
    await deps.store.recordReplyResult(id, result);
  } catch (err) {
    // sending のまま残った場合、finish / markStalled で unknown として扱われる
    deps.logger.error(`[line:webhook] failed to record reply result=${result}, event=${id}`, errorSummary(err));
  }
}

/** エラーの概要だけを返す（スタックや本文に個人情報が含まれる可能性を避ける） */
function errorSummary(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 300);
  return "unknown error";
}
