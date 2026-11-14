import { DbError } from "@/lib/db/errors";
import { type RetentionStore, SupabaseRetentionStore } from "@/lib/db/retention";
import { cronJson, rejectUnauthorizedCron } from "@/lib/notify/cron";
import { createServerSupabaseClient, readSupabaseServerConfig } from "@/lib/supabase/server";

/**
 * /api/cron/retention：保持期間を過ぎたデータの削除（Vercel Schedules から 1 日 1 回）。
 *
 * HTTP ステータス（Vercel の実行履歴で成否を確認する。パスのターゲットは再試行されない）
 *   200 … 削除した（件数だけを返す）、または別の削除処理が実行中で何もしなかった（busy）
 *   401 … 認証の失敗 / 503 … CRON_SECRET が未設定・短すぎる（DB に接続しない）
 *   500 … Supabase の接続情報がない・DB エラー・想定外の戻り値（詳細は返さない。ログにはコードだけ）
 * 何度呼ばれても安全（DB 側で期限切れの行だけを削除し、同時実行は busy になる）。
 */
export type RetentionCronDeps = { store: RetentionStore | null; logger: Pick<Console, "info" | "error"> };

export async function handleRetentionCron(
  request: Request,
  cronSecret: string | undefined,
  getDeps: () => RetentionCronDeps,
): Promise<Response> {
  const rejected = rejectUnauthorizedCron(request, cronSecret);
  if (rejected) return rejected;

  let deps: RetentionCronDeps;
  try {
    deps = getDeps();
  } catch (err) {
    console.error("[cron:retention] configuration error", err instanceof Error ? err.name : "unknown");
    return cronJson({ ok: false, error: "configuration" }, 500);
  }
  if (!deps.store) {
    // 削除の対象は Supabase にしかない。接続情報がないのは設定漏れなので失敗として残す
    deps.logger.error("[cron:retention] supabase is not configured");
    return cronJson({ ok: false, error: "not_configured" }, 500);
  }

  try {
    const r = await deps.store.purge();
    if (r.result === "busy") {
      deps.logger.info("[cron:retention] another purge is running; skipped");
      return cronJson({ ok: true, result: "busy" }, 200);
    }
    deps.logger.info("[cron:retention] purged", JSON.stringify(r.deleted));
    return cronJson({ ok: true, result: "purged", deleted: r.deleted }, 200);
  } catch (err) {
    const code = err instanceof DbError ? `${err.operation}:${err.code ?? "unknown"}` : "unexpected";
    deps.logger.error("[cron:retention] purge failed", code.slice(0, 100));
    return cronJson({ ok: false, error: "purge_failed" }, 500);
  }
}

/** 本番用の依存（Supabase の service_role クライアント）。接続情報がなければ store は null */
export function createRetentionDepsFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionCronDeps {
  const config = readSupabaseServerConfig(env);
  return { store: config ? new SupabaseRetentionStore(createServerSupabaseClient(config)) : null, logger: console };
}
