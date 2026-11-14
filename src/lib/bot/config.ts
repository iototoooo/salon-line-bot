import { createClaudeAnswerModel, readClaudeConfig } from "@/lib/ai/claude-model";
import { reserveAiUsage } from "@/lib/db/ai-usage";
import { insertConversation } from "@/lib/db/conversations";
import { getShopSettings, listPublishedFaqs, listPublishedMenus } from "@/lib/db/shop";
import { echoResponder, type Logger, type Responder } from "@/lib/line/process-events";
import { createServerSupabaseClient, readSupabaseServerConfig, SupabaseConfigError } from "@/lib/supabase/server";
import { createAiResponder } from "./ai-responder";

/**
 * 返信内容を決める Responder の切り替え（サーバー専用）。
 *
 * LINE_RESPONDER
 *   - "echo"（未設定時の既定）: ローカル検証用の Echo 応答。本番（VERCEL_ENV=production）では使用不可
 *   - "ai"                    : FAQ・メニュー・店舗情報に基づく AI 応答。Supabase の接続情報が必須
 *                               ANTHROPIC_API_KEY が未設定の場合は AI を呼ばず、定型文＋要オーナー対応になる
 *
 * AI 応答でも shop_settings.bot_enabled = false の間は AI を呼ばず、定型文だけを返す。
 * 署名検証・重複防止・返信トークンの管理は Responder の外側（webhook-handler / process-events）で行う。
 */
export type ResponderKind = "echo" | "ai";

export function resolveResponderKind(env: NodeJS.ProcessEnv = process.env): ResponderKind {
  const v = (env.LINE_RESPONDER ?? "").trim();
  const kind = v === "" ? "echo" : v;
  if (kind !== "echo" && kind !== "ai") {
    throw new SupabaseConfigError(`LINE_RESPONDER must be "echo" or "ai" (got "${v}")`);
  }
  if (kind === "echo" && env.VERCEL_ENV === "production") {
    throw new SupabaseConfigError("echo responder is not allowed in production; set LINE_RESPONDER=ai");
  }
  return kind;
}

export function createResponderFromEnv(env: NodeJS.ProcessEnv = process.env, logger: Logger = console): Responder {
  if (resolveResponderKind(env) === "echo") return echoResponder;

  const supabase = readSupabaseServerConfig(env);
  if (!supabase) {
    throw new SupabaseConfigError("LINE_RESPONDER=ai requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  const db = createServerSupabaseClient(supabase);
  const claude = readClaudeConfig(env);
  if (!claude) logger.warn("[bot] ANTHROPIC_API_KEY is not set; AI replies fall back to the fixed message");

  return createAiResponder({
    loadShopSettings: () => getShopSettings(db),
    loadFaqs: () => listPublishedFaqs(db),
    loadMenus: () => listPublishedMenus(db),
    saveConversation: (row) => insertConversation(db, row),
    model: claude ? createClaudeAnswerModel(claude) : null,
    usageLimiter: { reserve: (input) => reserveAiUsage(db, input) },
    logger,
  });
}
