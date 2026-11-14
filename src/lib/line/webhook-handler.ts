import { parseWebhookBody } from "./parse";
import type { Logger } from "./process-events";
import { verifyLineSignature } from "./signature";
import type { LineWebhookEvent } from "./types";

export type WebhookHandlerDeps = {
  channelSecret: string;
  /** レスポンス返却後に処理を続ける仕組み。本番は next/server の after、テストではキュー */
  schedule: (task: () => Promise<void>) => void;
  processEvents: (events: LineWebhookEvent[]) => Promise<unknown>;
  /**
   * 指定すると、2xx を返す前にイベントの処理権を取得（永続化）し、取得できたイベントだけを
   * processEvents に渡す。記録に失敗したら 500 を返す（LINE の再送設定が有効なら再送される）。
   * LINE の再送は 2xx 応答後の処理失敗を回復しないため、受付の記録は応答前に行う。
   */
  claimEvents?: (events: LineWebhookEvent[]) => Promise<{ claimed: LineWebhookEvent[]; error?: unknown }>;
  logger: Logger;
};

/** LINE の Webhook 本文としては十分大きい上限（異常なリクエストを早期に拒否する） */
export const MAX_BODY_BYTES = 1024 * 1024;

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

/**
 * POST /api/line/webhook の本体。
 *
 * 1. 生の本文で署名を検証する（検証前は DB 更新などの副作用を一切行わない）
 * 2. JSON を解析・検証する
 * 3. すぐに 200 を返し、イベント処理はレスポンス後に行う（返信トークンの期限と LINE 側のタイムアウト対策）
 */
export function createWebhookHandler(getDeps: () => WebhookHandlerDeps) {
  return async function handleLineWebhook(request: Request): Promise<Response> {
    let deps: WebhookHandlerDeps;
    try {
      deps = getDeps();
    } catch (err) {
      // 設定ミス（Supabase 未設定・本番でインメモリ等）。署名検証前でも処理は何も行わない
      console.error("[line:webhook] failed to initialize dependencies", summarize(err));
      return json(500, { error: "server_misconfigured" });
    }
    const { logger } = deps;

    if (!deps.channelSecret) {
      logger.error("[line:webhook] LINE_CHANNEL_SECRET is not configured");
      return json(500, { error: "server_misconfigured" });
    }

    const signature = request.headers.get("x-line-signature");
    if (!signature) {
      return json(401, { error: "missing_signature" });
    }

    let raw: Uint8Array;
    try {
      raw = new Uint8Array(await request.arrayBuffer());
    } catch {
      return json(400, { error: "unreadable_body" });
    }
    if (raw.byteLength > MAX_BODY_BYTES) {
      return json(413, { error: "payload_too_large" });
    }

    if (!verifyLineSignature(raw, signature, deps.channelSecret)) {
      logger.warn("[line:webhook] invalid signature");
      return json(401, { error: "invalid_signature" });
    }

    // ---- ここから下は署名検証済み ----

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return json(400, { error: "invalid_encoding" });
    }

    const parsed = parseWebhookBody(text);
    if (!parsed.ok) {
      logger.warn(`[line:webhook] rejected body: ${parsed.error}`);
      return json(400, { error: parsed.error });
    }

    const { events, invalidEventCount } = parsed.body;
    if (invalidEventCount > 0) {
      // 再送されても結果は変わらないため 200 で受理し、該当イベントだけ除外する
      logger.warn(`[line:webhook] ${invalidEventCount} event(s) dropped due to missing required fields`);
    }

    let toProcess = events;
    let storeError: unknown;
    if (deps.claimEvents && events.length > 0) {
      try {
        ({ claimed: toProcess, error: storeError } = await deps.claimEvents(events));
      } catch (err) {
        toProcess = [];
        storeError = err;
      }
    }

    // events が空（LINE Developers の「検証」ボタン等）や全件重複のときは処理を予約しない
    if (toProcess.length > 0) {
      const batch = toProcess;
      deps.schedule(async () => {
        try {
          await deps.processEvents(batch);
        } catch (err) {
          // processEvents はイベント単位で例外を捕捉するため、ここに来るのは想定外の不具合のみ
          logger.error("[line:webhook] unexpected error while processing events", summarize(err));
        }
      });
    }

    if (storeError !== undefined) {
      // 記録できたイベントは処理し、残りは LINE の再送（有効な場合）に委ねる
      logger.error("[line:webhook] failed to record events before acknowledging", summarize(storeError));
      return json(500, { error: "event_store_unavailable" });
    }

    return json(200, { status: "ok" });
  };
}

function summarize(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : "unknown error";
}
