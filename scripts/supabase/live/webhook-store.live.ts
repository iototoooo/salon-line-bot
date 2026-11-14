/**
 * 実 Supabase での Webhook イベント重複防止の検証（T1〜T6）。手動実行専用。
 *
 *   npm run test:live-webhook
 *
 * - 対象は Ref dnortggovlwgcdeoadbf のみ。.env.local の SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を使う
 * - 書き込みは public.line_webhook_events への DB 関数（RPC）経由だけ。最大 8 行（ID は実行ごとに固有）
 * - fetch を差し替え、許可した送信先・関数・イベント ID 以外は送信前に拒否する
 * - LINE はモック（dry-run・例外を投げるスタブ）だけを使う。Claude API は呼ばない
 * - 前提：4 本目のマイグレーション（reply_status = simulated）が適用済みであること
 * - 削除はしない（service_role に DELETE 権限はない）。削除用 SQL は記録ファイルに出力する
 * - 想定外の状態になった時点で停止する（再実行・修正はしない）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDryRunLineClient, LineApiError, type LineReplyClient } from "@/lib/line/client";
import { processEvents, type ProcessDeps, type Responder } from "@/lib/line/process-events";
import { SupabaseWebhookEventStore } from "@/lib/line/supabase-event-store";
import type { LineTextMessageEvent } from "@/lib/line/types";
import {
  createServerSupabaseClient,
  readSupabaseServerConfig,
  SUPABASE_PROJECT_REF,
  type ServerSupabaseClient,
} from "@/lib/supabase/server";

const EXPECTED_REF = "dnortggovlwgcdeoadbf";
const ORIGIN = `https://${EXPECTED_REF}.supabase.co`;
const ALLOWED_RPC = new Set([
  "claim_line_webhook_event",
  "begin_line_reply",
  "record_line_reply_result",
  "finish_line_webhook_event",
  "mark_stalled_line_webhook_events",
]);
const COLUMNS =
  "webhook_event_id, event_type, status, reply_status, last_error, needs_owner_notification, received_at, processed_at, reply_deadline_at, reply_attempted_at";

// ---------------------------------------------------------------------------
// 実行ごとの ID（8 件）
// ---------------------------------------------------------------------------
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
const PREFIX = `test-livecheck-${stamp}-${Math.random().toString(16).slice(2, 6)}`;
const ID = Object.fromEntries(
  ["01", "02", "03", "04", "05", "06", "07", "08"].map((n) => [n, `${PREFIX}-${n}`]),
) as Record<"01" | "02" | "03" | "04" | "05" | "06" | "07" | "08", string>;
const PLANNED_IDS = new Set(Object.values(ID));

// ---------------------------------------------------------------------------
// 送信先の制限（テスト中の全通信をここで検査する）
// ---------------------------------------------------------------------------
const guard = {
  allowMarkStalled: false,
  writtenIds: new Set<string>(),
  requests: [] as string[],
};

function installFetchGuard(realFetch: typeof fetch) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const deny = (why: string): never => {
      throw new Error(`[guard] 送信を拒否しました: ${method} ${url.origin}${url.pathname}（${why}）`);
    };
    if (url.origin !== ORIGIN) return deny("対象外の送信先");

    if (method === "GET" && url.pathname === "/rest/v1/line_webhook_events") {
      guard.requests.push(`GET line_webhook_events`);
      return realFetch(input, init);
    }
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (method !== "POST" || !rpc || !ALLOWED_RPC.has(rpc)) return deny("許可していない操作");
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    if (rpc === "mark_stalled_line_webhook_events") {
      if (!guard.allowMarkStalled) return deny("停止検出は事前確認の直後だけ許可");
      guard.allowMarkStalled = false; // 1 回だけ
    } else {
      const id = body.p_webhook_event_id;
      if (typeof id !== "string" || !PLANNED_IDS.has(id)) return deny("予定外のイベント ID");
      guard.writtenIds.add(id);
    }
    guard.requests.push(`POST rpc/${rpc}`);
    return realFetch(input, init);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------
type Row = {
  webhook_event_id: string;
  event_type: string;
  status: string;
  reply_status: string;
  last_error: string | null;
  needs_owner_notification: boolean;
  received_at: string;
  processed_at: string | null;
  reply_deadline_at: string;
  reply_attempted_at: string | null;
};

const log = (line: string) => console.log(`[live] ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function unwrap<T>(step: string, r: { data: T | null; error: { code?: string; message: string } | null; status: number }): T {
  if (r.error) throw new Error(`${step}: DB エラー（status=${r.status} code=${r.error.code ?? "-"}）`);
  if (r.data === null) throw new Error(`${step}: 応答が空`);
  return r.data;
}

async function readAll(ro: ServerSupabaseClient, step: string) {
  return unwrap(step, await ro.from("line_webhook_events").select("webhook_event_id, status").retry(false));
}

async function readTestRows(ro: ServerSupabaseClient, step: string): Promise<Map<string, Row>> {
  const rows = unwrap(
    step,
    await ro.from("line_webhook_events").select(COLUMNS).like("webhook_event_id", `${PREFIX}-%`).retry(false),
  ) as Row[];
  return new Map(rows.map((r) => [r.webhook_event_id, r]));
}

function textEvent(id: string): LineTextMessageEvent {
  // 架空の値。userId・本文は DB に保存されない（line_webhook_events に列がない）
  return {
    kind: "text",
    webhookEventId: id,
    timestamp: Date.now(),
    mode: "active",
    isRedelivery: false,
    source: { type: "user", userId: `U${"0".repeat(32)}` },
    replyToken: "dummy-reply-token",
    messageId: "dummy-message-id",
    text: "テスト",
  };
}

const okResponder: Responder = async () => [{ type: "text", text: "テスト応答" }];
const failingResponder: Responder = async () => {
  throw new Error("responder failure (test)");
};
const throwingClient = (err: unknown): LineReplyClient => ({
  async reply() {
    throw err;
  },
});

// ---------------------------------------------------------------------------
// 本体：1 つの流れとして順に実行し、最初の不一致で停止する
// ---------------------------------------------------------------------------
describe("実 Supabase：Webhook イベントの重複防止（T1〜T6）", () => {
  it("T1〜T6", async () => {
    const recordDir = join(tmpdir(), "salon-line-bot-live");
    mkdirSync(recordDir, { recursive: true });
    const recordFile = join(recordDir, `${PREFIX}.json`);
    const record: Record<string, unknown> = { prefix: PREFIX, plannedIds: [...PLANNED_IDS], startedAt: new Date().toISOString() };
    const save = () =>
      writeFileSync(recordFile, JSON.stringify({ ...record, writtenIds: [...guard.writtenIds], requests: guard.requests }, null, 2));
    save();
    log(`ID 接頭辞: ${PREFIX}`);
    log(`記録ファイル: ${recordFile}`);

    try {
      // ---- 事前確認 -------------------------------------------------------
      process.loadEnvFile(".env.local");
      const config = readSupabaseServerConfig(process.env);
      expect(config, "Supabase の設定がない").not.toBeNull();
      expect(SUPABASE_PROJECT_REF).toBe(EXPECTED_REF);
      expect(config!.projectRef).toBe(EXPECTED_REF);
      expect(config!.url).toBe(ORIGIN);
      log(`接続先: ${config!.url}（Ref: ${config!.projectRef}、キー: ${config!.keyKind}）`);

      installFetchGuard(fetch.bind(globalThis));
      const ro = createServerSupabaseClient(config!, { readOnly: true });
      const db = createServerSupabaseClient(config!);
      const store = new SupabaseWebhookEventStore(db);
      const dryRunLogs: string[] = [];
      const deps = (over: Partial<ProcessDeps>): ProcessDeps => ({
        store,
        client: createDryRunLineClient((m) => dryRunLogs.push(m)),
        respond: okResponder,
        fallbackMessage: "定型文（テスト）",
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        ...over,
      });

      const before = await readAll(ro, "事前確認");
      record.rowsBefore = before.length;
      expect(before.length, "line_webhook_events が空ではない（想定と異なるため停止）").toBe(0);
      log("事前確認: line_webhook_events は 0 行");

      // ---- T1 初回登録 ----------------------------------------------------
      expect(await store.claim({ webhookEventId: ID["01"], eventType: "test_livecheck", isRedelivery: false, eventTimestamp: Date.now() })).toBe(true);
      let rows = await readTestRows(ro, "T1");
      const r1 = rows.get(ID["01"])!;
      expect(rows.size).toBe(1);
      expect([r1.status, r1.reply_status, r1.processed_at]).toEqual(["processing", "none", null]);
      const window = Date.parse(r1.reply_deadline_at) - Date.parse(r1.received_at);
      expect(window).toBeGreaterThanOrEqual(49_000);
      expect(window).toBeLessThanOrEqual(51_000);
      log(`T1 OK: 初回 claim = true、processing/none、返信期限 = 受信 + ${window / 1000} 秒`);

      // ---- T2 同じ ID の重複防止 -------------------------------------------
      expect(await store.claim({ webhookEventId: ID["01"], eventType: "test_livecheck", isRedelivery: true })).toBe(false);
      expect(await store.claim({ webhookEventId: ID["01"], eventType: "other_type", isRedelivery: false })).toBe(false);
      rows = await readTestRows(ro, "T2");
      expect(rows.size).toBe(1);
      expect(rows.get(ID["01"])).toEqual(r1); // 受信時刻・種類を含め何も変わらない
      await store.finish(ID["01"], "skipped");
      const again = unwrap("T2", await db.rpc("finish_line_webhook_event", { p_webhook_event_id: ID["01"], p_status: "failed" }));
      expect(again, "終了済みのイベントを再度終了できてしまった").toBe(false);
      rows = await readTestRows(ro, "T2");
      expect([rows.get(ID["01"])!.status, rows.get(ID["01"])!.last_error]).toEqual(["skipped", null]);
      log("T2 OK: 再 claim 2 回とも false、行は 1 行のまま変化なし。終了済みへの finish も false");

      // ---- T3 同時リクエスト -----------------------------------------------
      const claims = await Promise.all(
        Array.from({ length: 10 }, () => store.claim({ webhookEventId: ID["02"], eventType: "test_livecheck", isRedelivery: false })),
      );
      expect(claims.filter(Boolean).length).toBe(1);
      const begins = await Promise.all(Array.from({ length: 10 }, () => store.beginReply(ID["02"])));
      expect(begins.filter(Boolean).length).toBe(1);
      await store.recordReplyResult(ID["02"], "sent");
      await store.finish(ID["02"], "done");
      rows = await readTestRows(ro, "T3");
      expect(rows.size).toBe(2);
      expect([rows.get(ID["02"])!.status, rows.get(ID["02"])!.reply_status]).toEqual(["done", "sent"]);
      log("T3 OK: 同時 claim 10 件中 true は 1 件、同時 beginReply 10 件中 true は 1 件");

      // ---- T4 返信の状態遷移（dry-run） ------------------------------------
      const ev3 = textEvent(ID["03"]);
      expect(await processEvents([ev3], deps({}))).toEqual(["simulated"]);
      expect(dryRunLogs.length).toBe(1);
      expect(await processEvents([{ ...ev3, isRedelivery: true }], deps({}))).toEqual(["duplicate"]);
      expect(await store.beginReply(ID["03"])).toBe(false);
      expect(dryRunLogs.length).toBe(1); // 重複時は返信しない
      rows = await readTestRows(ro, "T4");
      const r3 = rows.get(ID["03"])!;
      expect([r3.event_type, r3.status, r3.reply_status, r3.needs_owner_notification]).toEqual(["message", "done", "simulated", false]);
      expect(r3.processed_at).not.toBeNull();
      expect(r3.reply_attempted_at).not.toBeNull();
      log("T4 OK: dry-run → done/simulated（送信成功の sent とは区別）。再送は duplicate、返信済みトークンの再予約は false（dry-run 1 回のみ）");

      // ---- T5 エラー時の記録 -----------------------------------------------
      expect(await processEvents([textEvent(ID["04"])], deps({ client: throwingClient(new LineApiError(400, "dummy")) }))).toEqual(["failed"]);
      expect(
        await processEvents(
          [textEvent(ID["05"])],
          deps({ client: throwingClient(new DOMException("The operation was aborted due to timeout", "TimeoutError")) }),
        ),
      ).toEqual(["failed"]);
      expect(await processEvents([textEvent(ID["06"])], deps({ respond: failingResponder }))).toEqual(["failed_fallback_replied"]);
      // 返信期限 1 秒で受付 → 期限切れ後に処理
      expect(
        unwrap(
          "T5",
          await db.rpc("claim_line_webhook_event", {
            p_webhook_event_id: ID["07"],
            p_event_type: "message",
            p_is_redelivery: false,
            p_reply_window: "1 seconds",
          }),
        ),
      ).toBe(true);
      await sleep(2_000);
      const dryBefore = dryRunLogs.length;
      expect(await processEvents([textEvent(ID["07"])], deps({}), { alreadyClaimed: true })).toEqual(["reply_not_allowed"]);
      expect(dryRunLogs.length, "期限切れなのに返信した").toBe(dryBefore);

      rows = await readTestRows(ro, "T5");
      const pick = (id: string) => {
        const r = rows.get(id)!;
        return [r.status, r.reply_status, r.last_error, r.needs_owner_notification, r.processed_at !== null];
      };
      expect(pick(ID["04"])).toEqual(["failed", "failed", "reply_failed", true, true]);
      expect(pick(ID["05"])).toEqual(["failed", "unknown", "reply_unknown", true, true]);
      expect(pick(ID["06"])).toEqual(["failed", "simulated", "responder_failed", true, true]);
      expect(pick(ID["07"])).toEqual(["failed", "none", "reply_window_closed", true, true]);
      log("T5 OK: 400 → failed/failed、タイムアウト → failed/unknown、生成失敗 → 定型文 simulated・failed、期限切れ → 返信せず failed");

      // ---- T6 途中停止の検出 -----------------------------------------------
      expect(await store.claim({ webhookEventId: ID["08"], eventType: "message", isRedelivery: false })).toBe(true);
      expect(await store.beginReply(ID["08"])).toBe(true);
      log("T6: 返信中（sending）のまま 130 秒待機します");
      await sleep(130_000);

      const all = await readAll(ro, "T6 事前確認");
      const others = all.filter((r) => !PLANNED_IDS.has(r.webhook_event_id));
      expect(others.length, "テスト用以外の行がある（停止検出を実行せず停止）").toBe(0);
      const processing = all.filter((r) => r.status === "processing").map((r) => r.webhook_event_id);
      expect(processing, "停止検出の対象が想定と異なる").toEqual([ID["08"]]);
      log(`T6 事前確認: 全 ${all.length} 行がテスト用、processing は ${ID["08"]} の 1 行だけ`);

      guard.allowMarkStalled = true;
      const stalled = await store.markStalled(2 * 60_000);
      expect(stalled).toEqual([{ webhookEventId: ID["08"], eventType: "message", replyStatus: "unknown" }]);
      rows = await readTestRows(ro, "T6");
      const r8 = rows.get(ID["08"])!;
      expect([r8.status, r8.reply_status, r8.last_error, r8.needs_owner_notification]).toEqual([
        "abandoned",
        "unknown",
        "stalled: processing did not finish",
        true,
      ]);
      log("T6 OK: 停止検出は 1 行だけを abandoned/unknown・要通知に変更");

      // ---- 最終状態 ---------------------------------------------------------
      const final = await readTestRows(ro, "最終確認");
      expect(final.size).toBe(8);
      expect([...final.keys()].sort()).toEqual([...PLANNED_IDS].sort());
      expect([...guard.writtenIds].sort()).toEqual([...PLANNED_IDS].sort());
      record.finalRows = [...final.values()]
        .sort((a, b) => a.webhook_event_id.localeCompare(b.webhook_event_id))
        .map((r) => ({
          id: r.webhook_event_id,
          event_type: r.event_type,
          status: r.status,
          reply_status: r.reply_status,
          last_error: r.last_error,
          needs_owner_notification: r.needs_owner_notification,
        }));
      record.result = "passed";
      log(`完了: テスト用の行 ${final.size} 行、通信 ${guard.requests.length} 回（すべて許可した送信先）`);
    } catch (e) {
      record.result = "failed";
      record.error = e instanceof Error ? e.message.slice(0, 500) : "unknown";
      log(`停止しました: ${String(record.error)}`);
      log(`書き込んだ可能性のある ID: ${[...guard.writtenIds].join(", ") || "なし"}`);
      throw e;
    } finally {
      record.finishedAt = new Date().toISOString();
      save();
    }
  });
});
