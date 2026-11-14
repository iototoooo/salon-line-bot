import { createHash, timingSafeEqual } from "node:crypto";
import type { WebhookEventStore } from "@/lib/line/event-store";
import type { Logger } from "@/lib/line/process-events";
import type { FlushOutcome, OwnerNotifier } from "./owner-notifier";

/**
 * 定期実行（Vercel Schedules のパスのターゲット）の共通処理。
 *
 * 認証：Authorization: Bearer <CRON_SECRET>（Vercel がパスのターゲットに送るヘッダーの形式）。
 * CRON_SECRET が未設定・短すぎる場合は常に 503（無効）。比較は一定時間で行う。
 *
 * 結果の HTTP ステータス：
 *   200 … 成功（件数と結果コードだけを返す）
 *   500 … 処理の一部・全部が失敗。Vercel の実行履歴に「失敗」として残す（パスのターゲットは再試行されないため、
 *         500 を返しても二重実行にはならない。次回の定期実行で、未処理の分をまとめて扱う）
 */
export const MIN_CRON_SECRET_LENGTH = 32;

export function isAuthorized(header: string | null, secret: string): boolean {
  if (!header) return false;
  // 長さの違いも漏らさないよう、ハッシュ値どうしを比べる
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}

/**
 * 認証に失敗したときの応答を返す（成功なら null）。未認証の要求には、設定・接続の状態を明かさない。
 */
export function rejectUnauthorizedCron(request: Request, cronSecret: string | undefined): Response | null {
  const secret = cronSecret?.trim() ?? "";
  if (secret.length < MIN_CRON_SECRET_LENGTH) return cronJson({ ok: false, error: "disabled" }, 503);
  if (!isAuthorized(request.headers.get("authorization"), secret)) return cronJson({ ok: false, error: "unauthorized" }, 401);
  return null;
}

export function cronJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// /api/cron/owner-notify：停止イベントの検出とオーナー通知のまとめ送信（15 分ごと）
// ---------------------------------------------------------------------------
export type CronDeps = {
  store: WebhookEventStore | null;
  notifier: OwnerNotifier | null;
  logger: Logger;
};

/** 通知の結果のうち、実行履歴で「失敗」として気づけるようにするもの（LINE の拒否・成否不明・DB エラー） */
const FAILED_NOTIFICATION: ReadonlySet<string> = new Set(["error", "failed", "unknown"]);

export async function handleOwnerNotifyCron(
  request: Request,
  cronSecret: string | undefined,
  getDeps: () => CronDeps,
): Promise<Response> {
  const rejected = rejectUnauthorizedCron(request, cronSecret);
  if (rejected) return rejected;

  let deps: CronDeps;
  try {
    deps = getDeps();
  } catch (err) {
    console.error("[cron:owner-notify] configuration error", err instanceof Error ? err.name : "unknown");
    return cronJson({ ok: false, error: "configuration" }, 500);
  }

  let stalled: number | null = null;
  let stalledFailed = false;
  if (deps.store) {
    try {
      stalled = (await deps.store.markStalled()).length;
    } catch (err) {
      stalledFailed = true;
      deps.logger.error("[cron:owner-notify] failed to mark stalled events", err instanceof Error ? err.message.slice(0, 300) : "unknown");
    }
  }
  // 停止イベントの検出に失敗しても、通知のまとめ送信は行う（互いに独立）
  const notification: FlushOutcome | "disabled" = deps.notifier ? await deps.notifier.flush({ urgent: false }) : "disabled";

  const ok = !stalledFailed && !FAILED_NOTIFICATION.has(notification);
  // 件数と結果コードだけを返す（ID・本文は返さない）
  return cronJson({ ok, stalled, notification, ...(stalledFailed ? { error: "stalled_check_failed" } : {}) }, ok ? 200 : 500);
}
