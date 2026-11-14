import type { NotificationSource } from "@/lib/notify/owner-message";
import type {
  BatchResult,
  ClaimResult,
  OWNER_NOTIFICATION_LIMITS,
  OwnerNotificationStore,
} from "@/lib/notify/owner-notifier";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import { DbError, unwrap } from "./errors";

/**
 * オーナー通知の DB アクセス（7 本目のマイグレーション）。
 *   claim  → public.claim_owner_notification_batch
 *   finish → public.finish_owner_notification_batch
 *   詳細  → conversations（受信時の状態・質問の本文）と line_webhook_events（処理状態・エラーコード）
 * DB エラー・想定外の戻り値は DbError（コードのみ。個人情報を含めない）。
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIMPLE_RESULTS = new Set(["nothing", "throttled", "daily_limit", "busy"]);

export function parseClaimResult(data: unknown): ClaimResult {
  if (!data || typeof data !== "object") throw new DbError("claimOwnerNotificationBatch", "unexpected_result");
  const d = data as Record<string, unknown>;
  if (typeof d.result === "string" && SIMPLE_RESULTS.has(d.result)) {
    return { result: d.result as "nothing" | "throttled" | "daily_limit" | "busy" };
  }
  const ok =
    (d.result === "claimed" || d.result === "retry") &&
    typeof d.batch_id === "string" &&
    UUID.test(d.batch_id) &&
    typeof d.retry_key === "string" &&
    UUID.test(d.retry_key) &&
    Array.isArray(d.event_ids) &&
    d.event_ids.length > 0 &&
    d.event_ids.every((x) => typeof x === "string") &&
    typeof d.pending_count === "number" &&
    typeof d.urgent === "boolean" &&
    typeof d.attempt === "number";
  if (!ok) throw new DbError("claimOwnerNotificationBatch", "unexpected_result");
  return {
    result: d.result as "claimed" | "retry",
    batchId: d.batch_id as string,
    retryKey: d.retry_key as string,
    eventIds: d.event_ids as string[],
    pendingCount: d.pending_count as number,
    urgent: d.urgent as boolean,
    attempt: d.attempt as number,
  };
}

export class SupabaseOwnerNotificationStore implements OwnerNotificationStore {
  constructor(private readonly db: ServerSupabaseClient) {}

  async claim(input: { urgent: boolean; limits: typeof OWNER_NOTIFICATION_LIMITS }): Promise<ClaimResult> {
    const { data, error } = await this.db.rpc("claim_owner_notification_batch", {
      p_urgent: input.urgent,
      p_interval_minutes: input.limits.intervalMinutes,
      p_daily_limit: input.limits.dailyLimit,
      p_max_attempts: input.limits.maxAttempts,
    });
    if (error) throw new DbError("claimOwnerNotificationBatch", error.code);
    return parseClaimResult(data);
  }

  async finish(batchId: string, result: BatchResult, errorCode?: string): Promise<boolean> {
    const { data, error } = await this.db.rpc("finish_owner_notification_batch", {
      p_batch_id: batchId,
      p_result: result,
      p_error: errorCode,
    });
    if (error) throw new DbError("finishOwnerNotificationBatch", error.code);
    if (typeof data !== "boolean") throw new DbError("finishOwnerNotificationBatch", "unexpected_result");
    return data;
  }

  async loadSources(eventIds: string[]): Promise<NotificationSource[]> {
    if (eventIds.length === 0) return [];
    const [events, conversations] = await Promise.all([
      this.db.from("line_webhook_events").select("webhook_event_id, received_at, status, last_error").in("webhook_event_id", eventIds),
      // LINE ユーザー ID は取得しない（通知に載せないため）
      this.db.from("conversations").select("line_event_id, ai_status, error_message, user_message").in("line_event_id", eventIds),
    ]);
    const eventRows = unwrap("loadNotificationEvents", events) ?? [];
    const convRows = unwrap("loadNotificationConversations", conversations) ?? [];
    const conv = new Map(convRows.map((c) => [c.line_event_id, c]));

    return eventRows.map((e) => {
      const c = conv.get(e.webhook_event_id);
      return {
        eventId: e.webhook_event_id,
        receivedAt: e.received_at,
        conversation: c ? { aiStatus: c.ai_status, errorMessage: c.error_message, userMessage: c.user_message } : null,
        event: { status: e.status, lastError: e.last_error },
      };
    });
  }
}
