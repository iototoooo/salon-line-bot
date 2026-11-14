import { describe, expect, it, vi } from "vitest";
import { InMemoryWebhookEventStore } from "@/lib/line/event-store";
import { DEFAULT_FALLBACK_MESSAGE, echoResponder, processEvents } from "@/lib/line/process-events";
import type { LineWebhookEvent } from "@/lib/line/types";
import { createWebhookHandler, MAX_BODY_BYTES } from "@/lib/line/webhook-handler";
import {
  body,
  mockClient,
  NOW,
  signedRequest,
  silentLogger,
  stickerEvent,
  TEST_SECRET,
  textEvent,
} from "./fixtures";

/** after() の代わりに、レスポンス後のタスクを溜めて後から実行する */
function setup(opts: { secret?: string; processImpl?: (e: LineWebhookEvent[]) => Promise<unknown> } = {}) {
  const tasks: Array<() => Promise<void>> = [];
  const processSpy = vi.fn(opts.processImpl ?? (async () => {}));
  const logger = silentLogger();
  const handler = createWebhookHandler(() => ({
    channelSecret: opts.secret ?? TEST_SECRET,
    schedule: (t) => {
      tasks.push(t);
    },
    processEvents: processSpy,
    logger,
  }));
  const runScheduled = async () => {
    for (const t of tasks.splice(0)) await t();
  };
  return { handler, tasks, processSpy, logger, runScheduled };
}

describe("POST /api/line/webhook（ハンドラー）", () => {
  it("正しい署名なら 200 を返し、処理はレスポンス後に行う", async () => {
    const { handler, tasks, processSpy, runScheduled } = setup();
    const res = await handler(signedRequest(body([textEvent()])));
    expect(res.status).toBe(200);
    // レスポンス時点ではまだ処理していない
    expect(processSpy).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    await runScheduled();
    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy.mock.calls[0][0][0]).toMatchObject({ kind: "text" });
  });

  it("不正な署名は 401 で拒否し、何も処理しない", async () => {
    const { handler, tasks, processSpy } = setup();
    const res = await handler(signedRequest(body([textEvent()]), "wrong-secret"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_signature" });
    expect(tasks).toHaveLength(0);
    expect(processSpy).not.toHaveBeenCalled();
  });

  it("署名ヘッダーがなければ 401 で拒否する", async () => {
    const { handler, tasks } = setup();
    const res = await handler(signedRequest(body([textEvent()]), TEST_SECRET, null));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing_signature" });
    expect(tasks).toHaveLength(0);
  });

  it("署名後に本文を改ざんされたら 401", async () => {
    const { handler } = setup();
    const original = body([textEvent()]);
    const req = signedRequest(original.replace("営業時間", "料金"), TEST_SECRET, signedRequest(original).headers.get("x-line-signature"));
    expect((await handler(req)).status).toBe(401);
  });

  it("署名が正しくても JSON が不正なら 400", async () => {
    const { handler, tasks } = setup();
    const res = await handler(signedRequest("{invalid json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
    expect(tasks).toHaveLength(0);
  });

  it("署名が不正なら JSON が不正でも 401（署名検証が先）", async () => {
    const { handler } = setup();
    expect((await handler(signedRequest("{invalid json", "wrong"))).status).toBe(401);
  });

  it("本文の形が不正（events なし）なら 400", async () => {
    const { handler } = setup();
    const res = await handler(signedRequest('{"destination":"U1"}'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("不正な UTF-8 は 400", async () => {
    const { handler } = setup();
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    const { createLineSignature } = await import("@/lib/line/signature");
    const req = new Request("http://localhost/api/line/webhook", {
      method: "POST",
      headers: { "x-line-signature": createLineSignature(bytes, TEST_SECRET) },
      body: bytes,
    });
    expect((await handler(req)).status).toBe(400);
  });

  it("大きすぎる本文は 413", async () => {
    const { handler } = setup();
    const res = await handler(signedRequest("x".repeat(MAX_BODY_BYTES + 1)));
    expect(res.status).toBe(413);
  });

  it("events が空（LINE の検証リクエスト）は 200 を返し、処理を予約しない", async () => {
    const { handler, tasks } = setup();
    expect((await handler(signedRequest(body([])))).status).toBe(200);
    expect(tasks).toHaveLength(0);
  });

  it("必須項目が不足したイベントは除外し、正常なイベントだけ処理する（200）", async () => {
    const { handler, processSpy, runScheduled, logger } = setup();
    const res = await handler(signedRequest(body([textEvent({ webhookEventId: undefined }), textEvent()])));
    expect(res.status).toBe(200);
    await runScheduled();
    expect(processSpy.mock.calls[0][0]).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("1 event(s) dropped"));
  });

  it("シークレット未設定なら 500（設定ミスを検知できるように）", async () => {
    const { handler, tasks } = setup({ secret: "" });
    expect((await handler(signedRequest(body([textEvent()])))).status).toBe(500);
    expect(tasks).toHaveLength(0);
  });

  it("レスポンス後の処理で想定外の例外が起きてもログに残し、外へ投げない", async () => {
    const { handler, runScheduled, logger } = setup({
      processImpl: async () => {
        throw new Error("unexpected");
      },
    });
    expect((await handler(signedRequest(body([textEvent()])))).status).toBe(200);
    await expect(runScheduled()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("Webhook → Echo 返信の結合テスト（LINE 返信はモック）", () => {
  function integrated() {
    const client = mockClient();
    const store = new InMemoryWebhookEventStore();
    const tasks: Array<() => Promise<void>> = [];
    const logger = silentLogger();
    const handler = createWebhookHandler(() => ({
      channelSecret: TEST_SECRET,
      schedule: (t) => {
        tasks.push(t);
      },
      processEvents: (events) =>
        processEvents(events, {
          store,
          client,
          respond: echoResponder,
          fallbackMessage: DEFAULT_FALLBACK_MESSAGE,
          logger,
          now: () => NOW,
        }),
      logger,
    }));
    const flush = async () => {
      for (const t of tasks.splice(0)) await t();
    };
    return { handler, client, flush };
  }

  it("テキストとスタンプを含む Webhook に、それぞれ返信する", async () => {
    const { handler, client, flush } = integrated();
    const t = textEvent();
    const s = stickerEvent();
    expect((await handler(signedRequest(body([t, s])))).status).toBe(200);
    await flush();
    expect(client.reply).toHaveBeenCalledTimes(2);
    expect(client.reply.mock.calls[0]).toEqual([t.replyToken, [{ type: "text", text: "【テスト応答】営業時間は？" }]]);
    expect(client.reply.mock.calls[1][0]).toBe(s.replyToken);
  });

  it("同じ Webhook が再配信されても返信は 1 回だけ", async () => {
    const { handler, client, flush } = integrated();
    const e = textEvent();
    await handler(signedRequest(body([e])));
    await handler(signedRequest(body([{ ...e, deliveryContext: { isRedelivery: true } }])));
    await flush();
    expect(client.reply).toHaveBeenCalledTimes(1);
  });
});
