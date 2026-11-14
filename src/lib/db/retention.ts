import type { ServerSupabaseClient } from "@/lib/supabase/server";
import { DbError } from "./errors";

/**
 * 保持期間を過ぎたデータの削除（8 本目のマイグレーション：public.run_retention_purge）。
 * 保持期間は DB の関数の中で固定（会話 90 日・Webhook イベント 7 日・利用枠 2 日・通知記録 30 日）。
 * DB エラー・想定外の戻り値は DbError（コードのみ。個人情報を含めない）。
 */
export type RetentionCounts = {
  conversations: number;
  lineWebhookEvents: number;
  aiUsageReservations: number;
  ownerNotificationBatches: number;
};

export type RetentionResult = { result: "purged"; deleted: RetentionCounts } | { result: "busy" };

export interface RetentionStore {
  purge(): Promise<RetentionResult>;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function parseRetentionResult(data: unknown): RetentionResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new DbError("runRetentionPurge", "unexpected_result");
  const d = data as Record<string, unknown>;
  if (d.result === "busy") return { result: "busy" };
  if (
    d.result !== "purged" ||
    !isCount(d.conversations) ||
    !isCount(d.line_webhook_events) ||
    !isCount(d.ai_usage_reservations) ||
    !isCount(d.owner_notification_batches)
  ) {
    throw new DbError("runRetentionPurge", "unexpected_result");
  }
  return {
    result: "purged",
    deleted: {
      conversations: d.conversations,
      lineWebhookEvents: d.line_webhook_events,
      aiUsageReservations: d.ai_usage_reservations,
      ownerNotificationBatches: d.owner_notification_batches,
    },
  };
}

export class SupabaseRetentionStore implements RetentionStore {
  constructor(private readonly db: ServerSupabaseClient) {}

  async purge(): Promise<RetentionResult> {
    const { data, error } = await this.db.rpc("run_retention_purge");
    if (error) throw new DbError("runRetentionPurge", error.code);
    return parseRetentionResult(data);
  }
}
