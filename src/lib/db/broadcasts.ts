import type { ServerSupabaseClient } from "@/lib/supabase/server";
import type { BroadcastRow } from "@/types/database";
import { DbError, unwrap } from "./errors";

/**
 * 一斉配信の状態の変更（サーバー＝service_role 専用）。管理画面（authenticated）は状態を変更できない。
 * 状態遷移の正しさは DB のトリガー（private.broadcasts_guard）と start_broadcast_sending の条件付き更新でも守られる。
 *   draft / tested →（テスト送信）→ tested
 *   tested / failed →（start_broadcast_sending：送信権の取得。同時に 1 件だけ）→ sending → sent / failed
 */
export interface BroadcastStatusStore {
  markTested(id: string): Promise<boolean>;
  /** 送信権の取得。条件を満たさなければ例外（DB 関数が拒否） */
  startSending(id: string, estimatedRecipients: number, quotaRemaining: number): Promise<BroadcastRow>;
  markSent(id: string): Promise<boolean>;
  markFailed(id: string, code: string): Promise<boolean>;
}

export class SupabaseBroadcastStatusStore implements BroadcastStatusStore {
  constructor(private readonly db: ServerSupabaseClient) {}

  async markTested(id: string) {
    const data = unwrap(
      "markBroadcastTested",
      await this.db
        .from("broadcasts")
        .update({ status: "tested", tested_at: new Date().toISOString() })
        .eq("id", id)
        .in("status", ["draft", "tested"])
        .select("id"),
    );
    return (data?.length ?? 0) > 0;
  }

  async startSending(id: string, estimatedRecipients: number, quotaRemaining: number) {
    const { data, error } = await this.db.rpc("start_broadcast_sending", {
      p_broadcast_id: id,
      p_estimated_recipients: estimatedRecipients,
      p_quota_remaining: quotaRemaining,
    });
    if (error) throw new DbError("startBroadcastSending", error.code);
    if (!data || typeof data !== "object") throw new DbError("startBroadcastSending", "unexpected_result");
    return data as BroadcastRow;
  }

  async markSent(id: string) {
    const data = unwrap(
      "markBroadcastSent",
      await this.db
        .from("broadcasts")
        .update({ status: "sent", sent_at: new Date().toISOString(), error_message: null })
        .eq("id", id)
        .eq("status", "sending")
        .select("id"),
    );
    return (data?.length ?? 0) > 0;
  }

  async markFailed(id: string, code: string) {
    const data = unwrap(
      "markBroadcastFailed",
      await this.db
        .from("broadcasts")
        .update({ status: "failed", error_message: code.slice(0, 100) })
        .eq("id", id)
        .eq("status", "sending")
        .select("id"),
    );
    return (data?.length ?? 0) > 0;
  }
}
