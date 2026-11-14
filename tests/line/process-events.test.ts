import { describe, expect, it, vi } from "vitest";
import { createDryRunLineClient, type LineReplyClient } from "@/lib/line/client";
import { InMemoryWebhookEventStore, type WebhookEventStore } from "@/lib/line/event-store";
import { parseEvent } from "@/lib/line/parse";
import {
  DEFAULT_FALLBACK_MESSAGE,
  echoResponder,
  NON_TEXT_REPLY,
  processEvents,
  type ProcessDeps,
} from "@/lib/line/process-events";
import type { LineWebhookEvent } from "@/lib/line/types";
import { followEvent, mockClient, NOW, silentLogger, stickerEvent, textEvent, USER_ID } from "./fixtures";

const ev = (raw: unknown) => {
  const e = parseEvent(raw);
  if (!e) throw new Error("fixture is invalid");
  return e;
};

function setup(overrides: Partial<ProcessDeps> = {}) {
  const store = new InMemoryWebhookEventStore();
  const client = mockClient();
  const logger = silentLogger();
  const deps: ProcessDeps = {
    store,
    client,
    respond: echoResponder,
    fallbackMessage: DEFAULT_FALLBACK_MESSAGE,
    logger,
    now: () => NOW,
    ...overrides,
  };
  return { deps, store, client, logger };
}

describe("processEvents（Echo 応答・LINE 返信はモック）", () => {
  it("テキストメッセージに Echo で返信する", async () => {
    const { deps, client, store } = setup();
    const e = ev(textEvent());
    expect(await processEvents([e], deps)).toEqual(["replied"]);
    expect(client.reply).toHaveBeenCalledWith((e as { replyToken: string }).replyToken, [
      { type: "text", text: "【テスト応答】営業時間は？" },
    ]);
    expect(store.statusOf(e.webhookEventId)).toBe("done");
  });

  it("live の返信は sent として記録する", async () => {
    const { deps, store } = setup();
    const e = ev(textEvent());
    await processEvents([e], deps);
    expect(store.entryOf(e.webhookEventId)?.replyStatus).toBe("sent");
  });

  it("dry-run では送信せず simulated として記録し、送信成功（sent）と区別する", async () => {
    const log = vi.fn();
    const { deps, store } = setup({ client: createDryRunLineClient(log) });
    const e = ev(textEvent());
    expect(await processEvents([e], deps)).toEqual(["simulated"]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(store.entryOf(e.webhookEventId)).toMatchObject({ status: "done", replyStatus: "simulated" });
    // simulated のあとも同じトークンでは返信できない
    expect(await store.beginReply(e.webhookEventId)).toBe(false);
  });

  it("dry-run で返信内容の生成に失敗した場合も、定型文は simulated・要通知で記録する", async () => {
    const { deps, store } = setup({
      client: createDryRunLineClient(() => {}),
      respond: async () => {
        throw new Error("boom");
      },
    });
    const e = ev(textEvent());
    expect(await processEvents([e], deps)).toEqual(["failed_fallback_replied"]);
    expect(store.entryOf(e.webhookEventId)).toMatchObject({
      status: "failed",
      replyStatus: "simulated",
      needsOwnerNotification: true,
    });
  });

  it("返信クライアントが想定外の値を返したら、送信成功とみなさず unknown・要通知にする", async () => {
    const odd = { reply: vi.fn(async () => undefined) } as unknown as LineReplyClient;
    const { deps, store } = setup({ client: odd });
    const e = ev(textEvent());
    expect(await processEvents([e], deps)).toEqual(["failed"]);
    expect(store.entryOf(e.webhookEventId)).toMatchObject({
      status: "failed",
      replyStatus: "unknown",
      error: "reply_unknown",
      needsOwnerNotification: true,
    });
  });

  it("Echo は LINE の文字数上限（5000）を超えない", async () => {
    const { deps, client } = setup();
    await processEvents([ev(textEvent({ message: { id: "1", type: "text", text: "あ".repeat(6000) } }))], deps);
    expect(client.reply.mock.calls[0][1][0].text).toHaveLength(5000);
  });

  it("スタンプには定型文で返信する", async () => {
    const { deps, client } = setup();
    expect(await processEvents([ev(stickerEvent())], deps)).toEqual(["replied"]);
    expect(client.reply.mock.calls[0][1]).toEqual([{ type: "text", text: NON_TEXT_REPLY }]);
  });

  it("follow など message 以外のイベントは返信せずスキップ", async () => {
    const { deps, client, store } = setup();
    const e = ev(followEvent());
    expect(await processEvents([e], deps)).toEqual(["skipped"]);
    expect(client.reply).not.toHaveBeenCalled();
    expect(store.statusOf(e.webhookEventId)).toBe("skipped");
  });

  it("standby モードのイベントには返信しない", async () => {
    const { deps, client } = setup();
    expect(await processEvents([ev(textEvent({ mode: "standby" }))], deps)).toEqual(["skipped"]);
    expect(client.reply).not.toHaveBeenCalled();
  });

  it("グループ・トークルームからのメッセージには返信しない", async () => {
    const { deps, client } = setup();
    const out = await processEvents(
      [ev(textEvent({ source: { type: "group", groupId: "C1", userId: USER_ID } }))],
      deps,
    );
    expect(out).toEqual(["skipped"]);
    expect(client.reply).not.toHaveBeenCalled();
  });

  it("同じ webhookEventId は 1 回しか返信しない（再配信を含む）", async () => {
    const { deps, client } = setup();
    const first = textEvent();
    const redelivered = { ...first, deliveryContext: { isRedelivery: true } };
    const out = await processEvents([ev(first), ev(first), ev(redelivered)], deps);
    expect(out).toEqual(["replied", "duplicate", "duplicate"]);
    expect(client.reply).toHaveBeenCalledTimes(1);
  });

  it("別々の呼び出し（並行実行）でも重複イベントには 1 回しか返信しない", async () => {
    const { deps, client } = setup();
    const e = ev(textEvent());
    const results = await Promise.all([processEvents([e], deps), processEvents([e], deps)]);
    expect(results.flat().sort()).toEqual(["duplicate", "replied"]);
    expect(client.reply).toHaveBeenCalledTimes(1);
  });

  it("返信内容の生成でエラーが起きたら定型文で返信し、failed を記録する", async () => {
    const respond = vi.fn().mockRejectedValue(new Error("AI timeout"));
    const { deps, client, store, logger } = setup({ respond });
    const e = ev(textEvent());
    expect(await processEvents([e], deps)).toEqual(["failed_fallback_replied"]);
    expect(client.reply.mock.calls[0][1]).toEqual([{ type: "text", text: DEFAULT_FALLBACK_MESSAGE }]);
    expect(store.statusOf(e.webhookEventId)).toBe("failed");
    expect(logger.error).toHaveBeenCalled();
  });

  it("LINE への返信が失敗したら同じトークンで再送せず failed を記録する", async () => {
    const { deps, client, store } = setup();
    client.reply.mockRejectedValue(new Error("LINE API error: 400"));
    const e = ev(textEvent());
    expect(await processEvents([e], deps)).toEqual(["failed"]);
    expect(client.reply).toHaveBeenCalledTimes(1);
    expect(store.statusOf(e.webhookEventId)).toBe("failed");
  });

  it("1 件が失敗しても後続のイベントは処理される", async () => {
    const { deps, client } = setup();
    client.reply.mockRejectedValueOnce(new Error("boom"));
    const out = await processEvents([ev(textEvent()), ev(textEvent())], deps);
    expect(out).toEqual(["failed", "replied"]);
  });

  it("重複判定ストアが使えないときは返信しない（二重返信を防ぐ）", async () => {
    const store: WebhookEventStore = {
      claim: vi.fn().mockRejectedValue(new Error("db down")),
      beginReply: vi.fn(),
      recordReplyResult: vi.fn(),
      finish: vi.fn(),
      markStalled: vi.fn(),
    };
    const { deps, client } = setup({ store });
    expect(await processEvents([ev(textEvent())], deps)).toEqual(["store_error"]);
    expect(client.reply).not.toHaveBeenCalled();
  });

  it("結果の記録に失敗しても返信結果は変わらない", async () => {
    const store: WebhookEventStore = {
      claim: vi.fn().mockResolvedValue(true),
      beginReply: vi.fn().mockResolvedValue(true),
      recordReplyResult: vi.fn().mockRejectedValue(new Error("db down")),
      finish: vi.fn().mockRejectedValue(new Error("db down")),
      markStalled: vi.fn(),
    };
    const { deps, logger } = setup({ store });
    expect(await processEvents([ev(textEvent())], deps)).toEqual(["replied"]);
    expect(logger.error).toHaveBeenCalled();
  });

  it("古いイベント（返信トークン期限切れの可能性）は警告を出す", async () => {
    const { deps, logger } = setup({ now: () => NOW + 60_000 });
    await processEvents([ev(textEvent())], deps);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("reply token may be expired"));
  });

  it("ログに userId やメッセージ本文を出さない", async () => {
    const respond = vi.fn().mockRejectedValue(new Error("x"));
    const { deps, logger } = setup({ respond });
    await processEvents([ev(textEvent({ message: { id: "1", type: "text", text: "秘密の相談" } }))], deps);
    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toContain(USER_ID);
    expect(logged).not.toContain("秘密の相談");
  });

  it("型：パース済みイベントの配列を受け取る", () => {
    const events: LineWebhookEvent[] = [ev(textEvent())];
    expect(events).toHaveLength(1);
  });
});
