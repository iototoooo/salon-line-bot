import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDryRunLineClient, LineApiError } from "@/lib/line/client";
import { WebhookEventStoreError } from "@/lib/line/event-store";
import { parseEvent } from "@/lib/line/parse";
import {
  claimEvents,
  DEFAULT_FALLBACK_MESSAGE,
  echoResponder,
  processEvents,
  type ProcessDeps,
} from "@/lib/line/process-events";
import { SupabaseWebhookEventStore } from "@/lib/line/supabase-event-store";
import type { LineWebhookEvent } from "@/lib/line/types";
import { mockClient, silentLogger, textEvent } from "../line/fixtures";
import { createMigratedDb } from "./pglite";
import { pgliteRpcClient } from "./rpc-adapter";

/**
 * SupabaseWebhookEventStore（TypeScript）＋ DB 関数（SQL）を、PGlite 上で結合して検証する。
 * 実際の Supabase・LINE には接続しない（LINE 返信はモック）。
 */
let db: PGlite;
let failNext: Error | null;

beforeAll(async () => {
  db = await createMigratedDb();
}, 60_000);

beforeEach(async () => {
  failNext = null;
  await db.exec("reset role; truncate public.line_webhook_events");
});

const store = () =>
  new SupabaseWebhookEventStore(
    pgliteRpcClient(db, {
      failWith: () => {
        const e = failNext;
        failNext = null;
        return e;
      },
    }),
  );

// 現在時刻のイベント（返信期限内）。now は実時間を使う（DB の now() と合わせるため）
const freshEvent = (overrides: Record<string, unknown> = {}): LineWebhookEvent => {
  const e = parseEvent(textEvent({ timestamp: Date.now(), ...overrides }));
  if (!e) throw new Error("invalid fixture");
  return e;
};

const row = async (id: string) =>
  (await db.query<Record<string, unknown>>("select * from public.line_webhook_events where webhook_event_id=$1", [id]))
    .rows[0];

function deps(s = store(), overrides: Partial<ProcessDeps> = {}) {
  const client = mockClient();
  const logger = silentLogger();
  const d: ProcessDeps = {
    store: s,
    client,
    respond: echoResponder,
    fallbackMessage: DEFAULT_FALLBACK_MESSAGE,
    logger,
    ...overrides,
  };
  return { d, client, logger };
}

describe("SupabaseWebhookEventStore × PGlite", () => {
  it("イベントの初回登録：done・返信 sent として記録される", async () => {
    const e = freshEvent();
    const { d, client } = deps();
    const { claimed } = await claimEvents([e], d.store, d.logger);
    expect(claimed).toHaveLength(1);
    expect(await processEvents(claimed, d, { alreadyClaimed: true })).toEqual(["replied"]);
    expect(client.reply).toHaveBeenCalledTimes(1);
    const r = await row(e.webhookEventId);
    expect(r).toMatchObject({ status: "done", reply_status: "sent", event_type: "message", is_redelivery: false });
    expect(r.event_timestamp).toBeInstanceOf(Date);
  });

  it("dry-run では done・返信 simulated として記録され、送信成功（sent）と区別される", async () => {
    const e = freshEvent();
    const log = vi.fn();
    const { d } = deps(store(), { client: createDryRunLineClient(log) });
    expect(await processEvents([e], d)).toEqual(["simulated"]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(await row(e.webhookEventId)).toMatchObject({ status: "done", reply_status: "simulated" });
    // 再送されても返信しない
    expect(await processEvents([{ ...e, isRedelivery: true }], d)).toEqual(["duplicate"]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("同じイベントの重複防止（再配信を含む）", async () => {
    const e = freshEvent();
    const { d, client } = deps();
    expect((await claimEvents([e], d.store, d.logger)).claimed).toHaveLength(1);
    expect((await claimEvents([{ ...e, isRedelivery: true }], d.store, d.logger)).claimed).toHaveLength(0);
    expect(await processEvents([e], d)).toEqual(["duplicate"]);
    expect(client.reply).not.toHaveBeenCalled();
  });

  it("並列受信時の重複防止：同じイベントを 10 リクエスト同時に受けても返信は 1 回", async () => {
    const e = freshEvent();
    const { d, client } = deps();
    const results = await Promise.all(Array.from({ length: 10 }, () => processEvents([e], d)));
    expect(results.flat().filter((o) => o === "replied")).toHaveLength(1);
    expect(results.flat().filter((o) => o === "duplicate")).toHaveLength(9);
    expect(client.reply).toHaveBeenCalledTimes(1);
  });

  it("同じイベントを 2 回処理しようとしても、返信トークンは 1 回しか使わない", async () => {
    const e = freshEvent();
    const { d, client } = deps();
    await claimEvents([e], d.store, d.logger);
    const [a, b] = await Promise.all([
      processEvents([e], d, { alreadyClaimed: true }),
      processEvents([e], d, { alreadyClaimed: true }),
    ]);
    expect([...a, ...b].sort()).toEqual(["replied", "reply_not_allowed"]);
    expect(client.reply).toHaveBeenCalledTimes(1);
  });

  it("処理失敗時の状態記録：LINE が 4xx で拒否 → reply_status=failed・要通知", async () => {
    const e = freshEvent();
    const { d, client } = deps();
    client.reply.mockRejectedValue(new LineApiError(400, "Invalid reply token"));
    expect(await processEvents([e], d)).toEqual(["failed"]);
    expect(await row(e.webhookEventId)).toMatchObject({
      status: "failed",
      reply_status: "failed",
      last_error: "reply_failed",
      needs_owner_notification: true,
    });
  });

  it("処理失敗時の状態記録：タイムアウト（成否不明）→ unknown として記録し、再送しない", async () => {
    const e = freshEvent();
    const { d, client } = deps();
    client.reply.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    expect(await processEvents([e], d)).toEqual(["failed"]);
    expect(client.reply).toHaveBeenCalledTimes(1);
    expect(await row(e.webhookEventId)).toMatchObject({ reply_status: "unknown", needs_owner_notification: true });
    // 再処理しても返信しない
    expect(await processEvents([e], d, { alreadyClaimed: true })).toEqual(["reply_not_allowed"]);
    expect(client.reply).toHaveBeenCalledTimes(1);
  });

  it("処理失敗時の状態記録：返信内容の生成に失敗 → 定型文で返信し、failed・要通知", async () => {
    const e = freshEvent();
    const { d, client } = deps(store(), { respond: vi.fn().mockRejectedValue(new Error("AI down")) });
    expect(await processEvents([e], d)).toEqual(["failed_fallback_replied"]);
    expect(client.reply.mock.calls[0][1]).toEqual([{ type: "text", text: DEFAULT_FALLBACK_MESSAGE }]);
    expect(await row(e.webhookEventId)).toMatchObject({
      status: "failed",
      reply_status: "sent",
      last_error: "responder_failed",
      needs_owner_notification: true,
    });
  });

  it("返信期限（受信後 50 秒）を過ぎたイベントには返信しない", async () => {
    const e = freshEvent();
    const { d, client } = deps();
    await claimEvents([e], d.store, d.logger);
    await db.query(
      "update public.line_webhook_events set reply_deadline_at = now() - interval '1 second' where webhook_event_id=$1",
      [e.webhookEventId],
    );
    expect(await processEvents([e], d, { alreadyClaimed: true })).toEqual(["reply_not_allowed"]);
    expect(client.reply).not.toHaveBeenCalled();
    expect(await row(e.webhookEventId)).toMatchObject({
      status: "failed",
      last_error: "reply_window_closed",
      needs_owner_notification: true,
    });
  });

  it("途中停止したイベントの検出：processing のまま残ったイベントを abandoned にし、要通知にする", async () => {
    const s = store();
    const stopped = freshEvent();
    const sendingThenCrashed = freshEvent();
    const { d } = deps(s);
    await claimEvents([stopped, sendingThenCrashed], s, d.logger);
    // 返信予約後にプロセスが落ちた状況（結果も終了も記録されない）
    await s.beginReply(sendingThenCrashed.webhookEventId);
    await db.query(
      "update public.line_webhook_events set processing_started_at = now() - interval '10 minutes'",
    );

    const stalled = await s.markStalled();
    expect(stalled.map((x) => [x.webhookEventId, x.replyStatus]).sort()).toEqual(
      [
        [stopped.webhookEventId, "none"],
        [sendingThenCrashed.webhookEventId, "unknown"],
      ].sort(),
    );
    expect(await row(stopped.webhookEventId)).toMatchObject({ status: "abandoned", needs_owner_notification: true });
    // 停止扱いのイベントは再処理しても返信しない
    const { d: d2, client } = deps(s);
    expect(await processEvents([stopped], d2, { alreadyClaimed: true })).toEqual(["reply_not_allowed"]);
    expect(client.reply).not.toHaveBeenCalled();
  });

  it("停止検出の閾値は 2 分未満にできない", async () => {
    await expect(store().markStalled(60_000)).rejects.toThrow(/at least 2 minutes/);
  });

  describe("DB 接続エラー時の安全な処理", () => {
    it("claim のエラーは WebhookEventStoreError として伝わる", async () => {
      failNext = new Error("connection refused");
      await expect(store().claim({ webhookEventId: "x", eventType: "message", isRedelivery: false })).rejects.toThrow(
        WebhookEventStoreError,
      );
    });

    it("応答前の記録に失敗したら、それまで記録できたイベントだけを処理対象にしてエラーを返す", async () => {
      const s = store();
      const a = freshEvent();
      const b = freshEvent();
      const logger = silentLogger();
      // 1 件目は成功、2 件目で失敗させる
      const realClaim = s.claim.bind(s);
      let calls = 0;
      s.claim = async (input) => {
        calls++;
        if (calls === 2) throw new WebhookEventStoreError("claim", "TEST_FAILURE");
        return realClaim(input);
      };
      const result = await claimEvents([a, b], s, logger);
      expect(result.claimed.map((e) => e.webhookEventId)).toEqual([a.webhookEventId]);
      expect(result.error).toBeInstanceOf(WebhookEventStoreError);
      expect(await row(b.webhookEventId)).toBeUndefined();
    });

    it("返信予約で DB エラー → 返信しない（使用状況を記録できないまま送らない）", async () => {
      const s = store();
      const e = freshEvent();
      const { d, client } = deps(s);
      await claimEvents([e], s, d.logger);
      failNext = new Error("timeout");
      // respond は DB を使わないため、次の DB 呼び出しは beginReply
      expect(await processEvents([e], d, { alreadyClaimed: true })).toEqual(["store_error"]);
      expect(client.reply).not.toHaveBeenCalled();
      expect(await row(e.webhookEventId)).toMatchObject({ status: "failed", reply_status: "none" });
    });

    it("返信後の結果記録で DB エラー → 返信は 1 回のまま、終了時に unknown として残る", async () => {
      const s = store();
      const e = freshEvent();
      const { d, client } = deps(s);
      await claimEvents([e], s, d.logger);
      client.reply.mockImplementation(async () => {
        failNext = new Error("db down after reply"); // reply 直後の recordReplyResult を失敗させる
        return "sent";
      });
      expect(await processEvents([e], d, { alreadyClaimed: true })).toEqual(["replied"]);
      expect(client.reply).toHaveBeenCalledTimes(1);
      expect(await row(e.webhookEventId)).toMatchObject({ status: "done", reply_status: "unknown" });
    });
  });
});
