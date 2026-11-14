import type { ServerSupabaseClient } from "@/lib/supabase/server";
import {
  type ClaimInput,
  DEFAULT_STALLED_AFTER_MS,
  type EventFinalStatus,
  type FinishOptions,
  MIN_STALLED_AFTER_MS,
  REPLY_WINDOW_MS,
  type ReplyResult,
  type StalledEvent,
  type WebhookEventStore,
  WebhookEventStoreError,
} from "./event-store";

/** PostgreSQL の interval 文字列に変換する */
const toInterval = (ms: number) => `${Math.floor(ms / 1000)} seconds`;

type RpcError = { message: string; code?: string } | null;

function check<T>(operation: string, result: { data: T | null; error: RpcError }): T {
  if (result.error) {
    // エラーメッセージに個人情報は含まれない（関数の引数はイベント ID 等のみ）
    throw new WebhookEventStoreError(operation, result.error.code ?? result.error.message.slice(0, 100));
  }
  if (result.data === null) throw new WebhookEventStoreError(operation, "empty response");
  return result.data;
}

/**
 * line_webhook_events テーブルを使う永続的なストア。
 * 状態遷移の判定はすべて DB 側の関数（20261110010000_webhook_event_processing.sql）で
 * 条件付き UPDATE / INSERT ON CONFLICT として行い、並列実行でも 1 回だけ成功させる。
 */
export class SupabaseWebhookEventStore implements WebhookEventStore {
  constructor(private readonly db: ServerSupabaseClient) {}

  async claim(input: ClaimInput): Promise<boolean> {
    const result = await this.db.rpc("claim_line_webhook_event", {
      p_webhook_event_id: input.webhookEventId,
      p_event_type: input.eventType,
      p_is_redelivery: input.isRedelivery,
      // 値がなければ引数を省略し、DB 側の既定値（null）を使う
      ...(input.eventTimestamp === undefined ? {} : { p_event_timestamp: new Date(input.eventTimestamp).toISOString() }),
      p_reply_window: toInterval(REPLY_WINDOW_MS),
    });
    return check("claim", result) === true;
  }

  async beginReply(webhookEventId: string): Promise<boolean> {
    const result = await this.db.rpc("begin_line_reply", { p_webhook_event_id: webhookEventId });
    return check("beginReply", result) === true;
  }

  async recordReplyResult(webhookEventId: string, outcome: ReplyResult): Promise<void> {
    const result = await this.db.rpc("record_line_reply_result", {
      p_webhook_event_id: webhookEventId,
      p_result: outcome,
    });
    check("recordReplyResult", result);
  }

  async finish(webhookEventId: string, status: EventFinalStatus, options: FinishOptions = {}): Promise<void> {
    const result = await this.db.rpc("finish_line_webhook_event", {
      p_webhook_event_id: webhookEventId,
      p_status: status,
      ...(options.error === undefined ? {} : { p_error: options.error }),
      p_needs_owner_notification: options.needsOwnerNotification ?? false,
    });
    check("finish", result);
  }

  async markStalled(olderThanMs = DEFAULT_STALLED_AFTER_MS): Promise<StalledEvent[]> {
    if (olderThanMs < MIN_STALLED_AFTER_MS) throw new Error("olderThanMs must be at least 2 minutes");
    const result = await this.db.rpc("mark_stalled_line_webhook_events", {
      p_older_than: toInterval(olderThanMs),
    });
    return check("markStalled", result).map((r) => ({
      webhookEventId: r.webhook_event_id,
      eventType: r.event_type,
      replyStatus: r.reply_status,
    }));
  }
}
