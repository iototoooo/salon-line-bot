import { createServerSupabaseClient, readSupabaseServerConfig, SupabaseConfigError } from "@/lib/supabase/server";
import { createDryRunLineClient, createHttpLineClient, type LineReplyClient } from "./client";
import { InMemoryWebhookEventStore, type WebhookEventStore } from "./event-store";
import { SupabaseWebhookEventStore } from "./supabase-event-store";

/**
 * サーバー専用の LINE 設定。クライアントコンポーネントから import しないこと。
 *
 * LINE_REPLY_MODE
 *   - "dry-run"（既定）: LINE へは送信せず、ログだけを出す
 *   - "live"           : LINE_CHANNEL_ACCESS_TOKEN を使って実際に返信する
 *                        （テスト用公式アカウントで明示的に有効化するまで使わない）
 *
 * WEBHOOK_EVENT_STORE
 *   - "supabase": line_webhook_events に永続化（本番はこれ以外を許可しない）
 *   - "memory"  : プロセス内のみ（開発・テスト専用）
 *   - 未設定    : Supabase の接続情報があれば supabase、なければ memory
 */
export type LineReplyMode = "dry-run" | "live";
export type EventStoreKind = "supabase" | "memory";

export function getReplyMode(env: NodeJS.ProcessEnv = process.env): LineReplyMode {
  return env.LINE_REPLY_MODE === "live" ? "live" : "dry-run";
}

export function createLineClientFromEnv(env: NodeJS.ProcessEnv = process.env): LineReplyClient {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN ?? "";
  if (getReplyMode(env) === "live") {
    if (!token) {
      console.error("[line:config] LINE_REPLY_MODE=live but LINE_CHANNEL_ACCESS_TOKEN is empty; using dry-run");
      return createDryRunLineClient();
    }
    return createHttpLineClient(token);
  }
  return createDryRunLineClient();
}

export function resolveEventStoreKind(env: NodeJS.ProcessEnv = process.env): EventStoreKind {
  const v = env.WEBHOOK_EVENT_STORE;
  if (v === "supabase" || v === "memory") return v;
  if (v) throw new SupabaseConfigError(`WEBHOOK_EVENT_STORE must be "supabase" or "memory" (got "${v}")`);
  return readSupabaseServerConfig(env) ? "supabase" : "memory";
}

const isProductionDeployment = (env: NodeJS.ProcessEnv) => env.VERCEL_ENV === "production";

let memoryStore: InMemoryWebhookEventStore | undefined;

/**
 * 重複判定ストアを環境変数に応じて作る。
 * 本番（VERCEL_ENV=production）でインメモリ実装を使おうとした場合は例外にする
 * （永続的な重複防止がないまま稼働させない）。
 */
export function createWebhookEventStore(env: NodeJS.ProcessEnv = process.env): WebhookEventStore {
  const kind = resolveEventStoreKind(env);
  if (kind === "supabase") {
    const config = readSupabaseServerConfig(env);
    if (!config) {
      throw new SupabaseConfigError("WEBHOOK_EVENT_STORE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    }
    return new SupabaseWebhookEventStore(createServerSupabaseClient(config));
  }

  if (isProductionDeployment(env)) {
    throw new SupabaseConfigError("in-memory webhook event store is not allowed in production");
  }
  if (!memoryStore) {
    console.warn("[line:config] using in-memory webhook event store (not persistent; dev only)");
    memoryStore = new InMemoryWebhookEventStore();
  }
  return memoryStore;
}
