import { LineApiError, type LinePushClient } from "@/lib/line/client";
import type { Logger } from "@/lib/line/process-events";
import { MAX_LISTED_ITEMS, type NotificationSource, renderOwnerNotification, toItem } from "./owner-message";

/**
 * オーナー通知（WBS 2.5）。
 *
 * 通知の対象は line_webhook_events の「要通知・未通知」のイベント（AI 応答の要オーナー対応・返信失敗・処理の停止）。
 * flush() を呼ぶと、DB 関数で送信するまとめを確保し（間隔・1 日の上限・同時実行を DB 側で判定）、
 * オーナーの LINE へ 1 通の push で知らせ、結果を記録する。
 *
 * - お客様への返信の後（Webhook の after() の最後）と、定期実行（/api/cron/owner-notify）から呼ぶ
 * - 例外を外に出さない（通知の失敗でお客様への返信・処理状態の記録を止めない）
 * - 通知先が未設定・形式不正なら送らず、対象は未通知のまま残す（設定後の最初の通知にまとめて含まれる）
 * - LINE_REPLY_MODE=dry-run では DB にも LINE にも何もしない
 * - ログには LINE ユーザー ID・オーナーの ID・質問の本文を出さない
 */

/** 初期値。DB 関数の側でも範囲を検証する（間隔 1〜1440 分・1 日 1〜50 通・再送 1〜5 回） */
export const OWNER_NOTIFICATION_LIMITS = {
  /** 前回の送信（試行）からこの分数は送らない（その間の分は次の 1 通にまとまる） */
  intervalMinutes: 10,
  /** 日本時間の 1 日の送信数（失敗した試行を含む）。店舗全体の AI 利用上限の通知（1 日 1 回）は別枠 */
  dailyLimit: 5,
  /** 成否不明のまとめを同じ再送キーで送り直す回数の上限（初回を含む） */
  maxAttempts: 3,
} as const;

export type ClaimedBatch = {
  result: "claimed" | "retry";
  batchId: string;
  retryKey: string;
  eventIds: string[];
  pendingCount: number;
  urgent: boolean;
  attempt: number;
};
export type ClaimResult = ClaimedBatch | { result: "nothing" | "throttled" | "daily_limit" | "busy" };
export type BatchResult = "sent" | "failed" | "unknown";

export interface OwnerNotificationStore {
  /** 送信するまとめを確保する（claim_owner_notification_batch） */
  claim(input: { urgent: boolean; limits: typeof OWNER_NOTIFICATION_LIMITS }): Promise<ClaimResult>;
  /** 送信結果を記録する（finish_owner_notification_batch）。errorCode は個人情報を含まないコードのみ */
  finish(batchId: string, result: BatchResult, errorCode?: string): Promise<boolean>;
  /** 通知文に載せる詳細（会話ログ・イベントの記録） */
  loadSources(eventIds: string[]): Promise<NotificationSource[]>;
}

export type FlushOutcome =
  | "dry_run"
  | "no_recipient"
  | "nothing"
  | "throttled"
  | "daily_limit"
  | "busy"
  | BatchResult
  | "error";

export interface OwnerNotifier {
  /** 未通知の要対応イベントをまとめて送る。例外は投げない */
  flush(options?: { urgent?: boolean }): Promise<FlushOutcome>;
}

export type OwnerNotifierDeps = {
  /** dry-run：DB にも LINE にも何もしない（LINE_REPLY_MODE=live のときだけ live） */
  mode: "live" | "dry-run";
  store: OwnerNotificationStore;
  push: LinePushClient | null;
  /** shop_settings.owner_line_user_id */
  loadOwnerId: () => Promise<string | null>;
  appBaseUrl: string | null;
  logger: Logger;
  limits?: typeof OWNER_NOTIFICATION_LIMITS;
};

const LINE_USER_ID = /^U[0-9a-f]{32}$/;

export function createOwnerNotifier(deps: OwnerNotifierDeps): OwnerNotifier {
  const limits = deps.limits ?? OWNER_NOTIFICATION_LIMITS;
  const log = deps.logger;

  return {
    async flush(options = {}) {
      const urgent = options.urgent === true;
      if (deps.mode !== "live" || !deps.push) {
        log.info(`[owner-notify] dry-run: notification skipped (urgent=${urgent})`);
        return "dry_run";
      }
      try {
        return await flushLive(deps, deps.push, limits, urgent);
      } catch (err) {
        log.error("[owner-notify] unexpected failure", summary(err));
        return "error";
      }
    },
  };
}

async function flushLive(
  deps: OwnerNotifierDeps,
  push: LinePushClient,
  limits: typeof OWNER_NOTIFICATION_LIMITS,
  urgent: boolean,
): Promise<FlushOutcome> {
  const log = deps.logger;

  // 1. 通知先（オーナーの LINE ユーザー ID）。未設定なら確保せず、対象は未通知のまま残す
  let ownerId: string | null;
  try {
    ownerId = await deps.loadOwnerId();
  } catch (err) {
    log.error("[owner-notify] failed to load the notification destination", summary(err));
    return "error";
  }
  if (!ownerId || !LINE_USER_ID.test(ownerId)) {
    log.warn("[owner-notify] owner_line_user_id is not set (or invalid); notifications are kept pending");
    return "no_recipient";
  }

  // 2. 送信するまとめの確保（間隔・1 日の上限・同時実行は DB 側で判定）
  let claim: ClaimResult;
  try {
    claim = await deps.store.claim({ urgent, limits });
  } catch (err) {
    log.error("[owner-notify] failed to claim a notification batch", summary(err));
    return "error";
  }
  if (claim.result !== "claimed" && claim.result !== "retry") {
    if (claim.result !== "nothing") log.info(`[owner-notify] not sent: ${claim.result}`);
    return claim.result;
  }

  // 3. 本文（詳細が読めなくても件数とリンクだけで送る）
  let sources: NotificationSource[] = [];
  try {
    sources = await deps.store.loadSources(claim.eventIds.slice(0, MAX_LISTED_ITEMS));
  } catch (err) {
    log.error("[owner-notify] failed to load notification details; sending the count only", summary(err));
  }
  const order = new Map(claim.eventIds.map((id, i) => [id, i]));
  const items = sources
    .filter((s) => order.has(s.eventId))
    .sort((a, b) => (order.get(a.eventId) ?? 0) - (order.get(b.eventId) ?? 0))
    .map(toItem);
  const text = renderOwnerNotification({
    items,
    total: claim.pendingCount,
    urgent: claim.urgent,
    appBaseUrl: deps.appBaseUrl,
  });

  // 4. push（成否不明は同じ再送キーで後から送り直す。LINE が受理済みなら 409 で二重に届かない）
  let result: BatchResult;
  let code: string | undefined;
  try {
    const r = await push.push(ownerId, [{ type: "text", text }], claim.retryKey);
    result = "sent";
    code = r === "duplicate" ? "already_accepted" : undefined;
  } catch (err) {
    [result, code] = classifyPushError(err);
    log.error(`[owner-notify] push ${result} (${code}), attempt=${claim.attempt}`);
  }

  // 5. 結果の記録。失敗しても、送信中のまとめは 2 分後に成否不明として同じキーで再送される
  try {
    await deps.store.finish(claim.batchId, result, result === "sent" ? undefined : code);
  } catch (err) {
    log.error(`[owner-notify] failed to record result=${result}`, summary(err));
  }
  if (result === "sent") {
    log.info(`[owner-notify] sent ${claim.eventIds.length} item(s), attempt=${claim.attempt}${code ? ` (${code})` : ""}`);
  }
  return result;
}

/**
 * push の失敗を分類する（LINE 公式：5xx・タイムアウトは再試行、4xx は再試行しても結果が変わらない）。
 *   4xx → failed（対象は次のまとめへ・新しい再送キー）
 *   5xx・タイムアウト・通信エラー → unknown（同じ再送キーで再送）
 *   宛先・キーの形式エラー（送信前に拒否）→ failed
 */
export function classifyPushError(err: unknown): [BatchResult, string] {
  if (err instanceof LineApiError) {
    if (err.status >= 400 && err.status < 500) return ["failed", `push_http_${err.status}`];
    return ["unknown", `push_http_${err.status}`];
  }
  if (err instanceof Error && err.message.startsWith("push: invalid")) return ["failed", "push_invalid_request"];
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return ["unknown", "push_timeout"];
  return ["unknown", "push_network_error"];
}

function summary(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : "unknown error";
}
