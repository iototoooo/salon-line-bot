import { describe, expect, it, vi } from "vitest";
import { LineApiError } from "@/lib/line/client";
import { InMemoryWebhookEventStore } from "@/lib/line/event-store";
import { parseEvent } from "@/lib/line/parse";
import {
  claimEvents,
  classifyReplyError,
  DEFAULT_FALLBACK_MESSAGE,
  echoResponder,
  MAX_MESSAGES_PER_REPLY,
  processEvents,
} from "@/lib/line/process-events";
import type { LineWebhookEvent } from "@/lib/line/types";
import { createWebhookHandler } from "@/lib/line/webhook-handler";
import { body, mockClient, NOW, signedRequest, silentLogger, TEST_SECRET, textEvent } from "./fixtures";

const ev = (raw: unknown): LineWebhookEvent => {
  const e = parseEvent(raw);
  if (!e) throw new Error("invalid fixture");
  return e;
};

function setup(clock = { t: NOW }) {
  const store = new InMemoryWebhookEventStore(24 * 3600_000, 10_000, () => clock.t);
  const client = mockClient();
  const logger = silentLogger();
  const deps = { store, client, respond: echoResponder, fallbackMessage: DEFAULT_FALLBACK_MESSAGE, logger, now: () => clock.t };
  return { store, client, logger, deps, clock };
}

describe("返信トークンの期限と使用状況（インメモリ実装）", () => {
  it("受信後 50 秒を過ぎたら返信しない（LINE 仕様：1 分以内）", async () => {
    const { deps, client, store, clock } = setup();
    const e = ev(textEvent());
    await claimEvents([e], store, deps.logger);
    clock.t += 50_000;
    expect(await processEvents([e], deps, { alreadyClaimed: true })).toEqual(["reply_not_allowed"]);
    expect(client.reply).not.toHaveBeenCalled();
    expect(store.entryOf(e.webhookEventId)).toMatchObject({ status: "failed", needsOwnerNotification: true });
  });

  it("49 秒なら返信する", async () => {
    const { deps, client, store, clock } = setup();
    const e = ev(textEvent());
    await claimEvents([e], store, deps.logger);
    clock.t += 49_000;
    expect(await processEvents([e], deps, { alreadyClaimed: true })).toEqual(["replied"]);
    expect(client.reply).toHaveBeenCalledTimes(1);
  });

  it("一度返信したイベントを再処理しても、同じトークンでは返信しない", async () => {
    const { deps, client } = setup();
    const e = ev(textEvent());
    await processEvents([e], deps);
    expect(await processEvents([e], deps, { alreadyClaimed: true })).toEqual(["reply_not_allowed"]);
    expect(client.reply).toHaveBeenCalledTimes(1);
  });

  it("返信予約で例外 → 返信しない", async () => {
    const { deps, client, store } = setup();
    store.beginReply = vi.fn().mockRejectedValue(new Error("db down"));
    expect(await processEvents([ev(textEvent())], deps)).toEqual(["store_error"]);
    expect(client.reply).not.toHaveBeenCalled();
  });

  it("メッセージは 5,000 文字・5 件までに切り詰める", async () => {
    const { deps, client } = setup();
    deps.respond = async () => Array.from({ length: 7 }, () => ({ type: "text" as const, text: "あ".repeat(6000) }));
    await processEvents([ev(textEvent())], deps);
    const sent = client.reply.mock.calls[0][1];
    expect(sent).toHaveLength(MAX_MESSAGES_PER_REPLY);
    expect(sent.every((m) => m.text.length === 5000)).toBe(true);
  });
});

describe("外部送信の成否判定", () => {
  it.each([
    ["LINE 400（不正なトークン等）", new LineApiError(400, ""), "failed"],
    ["LINE 429（レート制限）", new LineApiError(429, ""), "failed"],
    ["LINE 500", new LineApiError(500, ""), "unknown"],
    ["タイムアウト", new DOMException("timeout", "TimeoutError"), "unknown"],
    ["通信エラー", new TypeError("fetch failed"), "unknown"],
  ])("%s → %s", (_l, err, expected) => {
    expect(classifyReplyError(err)).toBe(expected);
  });

  it("成否不明でも同じトークンで再送しない", async () => {
    const { deps, client, store } = setup();
    client.reply.mockRejectedValue(new TypeError("fetch failed"));
    const e = ev(textEvent());
    expect(await processEvents([e], deps)).toEqual(["failed"]);
    expect(client.reply).toHaveBeenCalledTimes(1);
    expect(store.entryOf(e.webhookEventId)).toMatchObject({ replyStatus: "unknown", needsOwnerNotification: true });
  });
});

describe("途中停止したイベントの検出（インメモリ実装）", () => {
  it("5 分以上 processing のままのイベントを abandoned・要通知にする", async () => {
    const { store, clock, deps } = setup();
    const stopped = ev(textEvent());
    const done = ev(textEvent());
    await claimEvents([stopped], store, deps.logger);
    await processEvents([done], deps);
    clock.t += 5 * 60_000 + 1;
    const stalled = await store.markStalled();
    expect(stalled.map((s) => s.webhookEventId)).toEqual([stopped.webhookEventId]);
    expect(store.entryOf(stopped.webhookEventId)).toMatchObject({ status: "abandoned", needsOwnerNotification: true });
    expect(store.statusOf(done.webhookEventId)).toBe("done");
  });

  it("閾値 2 分未満は拒否", async () => {
    await expect(setup().store.markStalled(1000)).rejects.toThrow();
  });
});

describe("Webhook 応答前の記録（claimEvents を使うハンドラー）", () => {
  function handlerWith(store: InMemoryWebhookEventStore, client = mockClient()) {
    const tasks: Array<() => Promise<void>> = [];
    const logger = silentLogger();
    const deps = { store, client, respond: echoResponder, fallbackMessage: DEFAULT_FALLBACK_MESSAGE, logger, now: () => NOW };
    const handler = createWebhookHandler(() => ({
      channelSecret: TEST_SECRET,
      schedule: (t) => {
        tasks.push(t);
      },
      claimEvents: (events) => claimEvents(events, store, logger),
      processEvents: (events) => processEvents(events, deps, { alreadyClaimed: true }),
      logger,
    }));
    const flush = async () => {
      for (const t of tasks.splice(0)) await t();
    };
    return { handler, client, tasks, flush, logger };
  }

  it("応答前にイベントを記録し、重複は処理を予約しない", async () => {
    const store = new InMemoryWebhookEventStore(undefined, undefined, () => NOW);
    const { handler, client, tasks, flush } = handlerWith(store);
    const e = textEvent();
    expect((await handler(signedRequest(body([e])))).status).toBe(200);
    expect(store.statusOf(e.webhookEventId)).toBe("processing"); // 200 の時点で記録済み
    expect((await handler(signedRequest(body([{ ...e, deliveryContext: { isRedelivery: true } }])))).status).toBe(200);
    expect(tasks).toHaveLength(1);
    await flush();
    expect(client.reply).toHaveBeenCalledTimes(1);
  });

  it("記録に失敗したら 500（LINE の再送に委ねる）。記録できた分は処理する", async () => {
    const store = new InMemoryWebhookEventStore(undefined, undefined, () => NOW);
    const real = store.claim.bind(store);
    let n = 0;
    store.claim = async (input) => {
      if (++n === 2) throw new Error("db down");
      return real(input);
    };
    const { handler, client, flush } = handlerWith(store);
    const a = textEvent();
    const b = textEvent();
    const res = await handler(signedRequest(body([a, b])));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "event_store_unavailable" });
    await flush();
    expect(client.reply).toHaveBeenCalledTimes(1);
    expect(client.reply.mock.calls[0][0]).toBe(a.replyToken);

    // 再送されたら、処理済みの a は重複、b は新規として処理される
    store.claim = real;
    const redelivered = [a, b].map((x) => ({ ...x, deliveryContext: { isRedelivery: true } }));
    expect((await handler(signedRequest(body(redelivered)))).status).toBe(200);
    await flush();
    expect(client.reply).toHaveBeenCalledTimes(2);
    expect(client.reply.mock.calls[1][0]).toBe(b.replyToken);
  });

  it("依存関係の初期化に失敗（設定ミス）したら 500", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createWebhookHandler(() => {
      throw new Error("WEBHOOK_EVENT_STORE=supabase requires SUPABASE_URL");
    });
    const res = await handler(signedRequest(body([textEvent()])));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
    errSpy.mockRestore();
  });
});
