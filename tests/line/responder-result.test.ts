import { describe, expect, it, vi } from "vitest";
import { createDryRunLineClient, type LineReplyClient } from "@/lib/line/client";
import { InMemoryWebhookEventStore } from "@/lib/line/event-store";
import { parseEvent } from "@/lib/line/parse";
import {
  DEFAULT_FALLBACK_MESSAGE,
  echoResponder,
  processEvents,
  type ProcessDeps,
  type ReplyDeliveryOutcome,
  type Responder,
} from "@/lib/line/process-events";
import type { LineWebhookEvent } from "@/lib/line/types";
import { LineApiError } from "@/lib/line/client";
import { mockClient, NOW, silentLogger, textEvent } from "./fixtures";

// Responder の戻り値の拡張（ResponderResult）。Echo（配列を返す）との互換性を確認する
const ev = (raw: unknown) => parseEvent(raw) as LineWebhookEvent;

function setup(respond: Responder, client: LineReplyClient = mockClient()) {
  const store = new InMemoryWebhookEventStore(undefined, undefined, () => NOW);
  const deps: ProcessDeps = { store, client, respond, fallbackMessage: DEFAULT_FALLBACK_MESSAGE, logger: silentLogger(), now: () => NOW };
  return { deps, store, client };
}

function resultResponder(options: { needsOwner?: boolean; afterReplyError?: boolean } = {}) {
  const deliveries: ReplyDeliveryOutcome[] = [];
  const respond: Responder = async () => ({
    messages: [{ type: "text", text: "回答" }],
    needsOwnerNotification: options.needsOwner,
    afterReply: async (d) => {
      deliveries.push(d);
      if (options.afterReplyError) throw new Error("log failed");
    },
  });
  return { respond, deliveries };
}

describe("ResponderResult（AI 応答用の拡張）", () => {
  it("Echo（配列を返す Responder）は従来どおり動く", async () => {
    const { deps, client, store } = setup(echoResponder);
    const e = ev(textEvent());
    expect(await processEvents([e], deps)).toEqual(["replied"]);
    expect(client.reply).toHaveBeenCalledWith(expect.any(String), [{ type: "text", text: "【テスト応答】営業時間は？" }]);
    expect(store.entryOf(e.webhookEventId)).toMatchObject({ status: "done", needsOwnerNotification: false });
  });

  it("送信結果（sent）を afterReply に渡す", async () => {
    const { respond, deliveries } = resultResponder();
    const { deps } = setup(respond);
    await processEvents([ev(textEvent())], deps);
    expect(deliveries).toEqual(["sent"]);
  });

  it("dry-run では simulated を渡す", async () => {
    const { respond, deliveries } = resultResponder();
    const { deps } = setup(respond, createDryRunLineClient(() => {}));
    expect(await processEvents([ev(textEvent())], deps)).toEqual(["simulated"]);
    expect(deliveries).toEqual(["simulated"]);
  });

  it("LINE が拒否（4xx）したら failed を渡す", async () => {
    const { respond, deliveries } = resultResponder();
    const client = { reply: vi.fn(async () => Promise.reject(new LineApiError(400, "bad"))) } as unknown as LineReplyClient;
    const { deps } = setup(respond, client);
    expect(await processEvents([ev(textEvent())], deps)).toEqual(["failed"]);
    expect(deliveries).toEqual(["failed"]);
  });

  it("needsOwnerNotification を処理状態の要通知に記録する（返信は成功扱い）", async () => {
    const { respond } = resultResponder({ needsOwner: true });
    const { deps, store } = setup(respond);
    const e = ev(textEvent());
    expect(await processEvents([e], deps)).toEqual(["replied"]);
    expect(store.entryOf(e.webhookEventId)).toMatchObject({ status: "done", needsOwnerNotification: true });
  });

  it("afterReply が失敗しても返信・処理状態の記録に影響しない", async () => {
    const { respond } = resultResponder({ afterReplyError: true });
    const { deps, store } = setup(respond);
    const e = ev(textEvent());
    expect(await processEvents([e], deps)).toEqual(["replied"]);
    expect(store.statusOf(e.webhookEventId)).toBe("done");
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it("afterReply には実際に送った文を渡す（返信が空なら定型文）", async () => {
    const sent: unknown[] = [];
    const { deps } = setup(async () => ({ messages: [], afterReply: async (_d, m) => void sent.push(m) }));
    expect(await processEvents([ev(textEvent())], deps)).toEqual(["failed_fallback_replied"]);
    expect(sent).toEqual([[{ type: "text", text: DEFAULT_FALLBACK_MESSAGE }]]);
  });

  it("Responder が例外なら既定の定型文で返信し、afterReply は呼ばれない", async () => {
    const { deps, client } = setup(async () => {
      throw new Error("x");
    });
    expect(await processEvents([ev(textEvent())], deps)).toEqual(["failed_fallback_replied"]);
    expect(client.reply).toHaveBeenCalledWith(expect.any(String), [{ type: "text", text: DEFAULT_FALLBACK_MESSAGE }]);
  });
});
