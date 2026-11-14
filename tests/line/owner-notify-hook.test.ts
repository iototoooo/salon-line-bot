import { describe, expect, it, vi } from "vitest";
import { createAiResponder } from "@/lib/bot/ai-responder";
import { type LineReplyClient } from "@/lib/line/client";
import { InMemoryWebhookEventStore } from "@/lib/line/event-store";
import { parseEvent } from "@/lib/line/parse";
import {
  DEFAULT_FALLBACK_MESSAGE,
  echoResponder,
  processEvents,
  type ProcessDeps,
  type Responder,
} from "@/lib/line/process-events";
import type { LineWebhookEvent } from "@/lib/line/types";
import { memoryUsageLimiter } from "../ai/fake-usage-limiter";
import { FAQS, fakeModel, MENUS, shopRow, draft } from "../ai/fixtures";
import { followEvent, mockClient, NOW, silentLogger, textEvent } from "./fixtures";

// Webhook 処理とオーナー通知（WBS 2.5）の連携。LINE・DB はモック
const ev = (raw: unknown) => parseEvent(raw) as LineWebhookEvent;

function setup(respond: Responder, notifyOwner?: ProcessDeps["notifyOwner"], client: LineReplyClient = mockClient()) {
  const store = new InMemoryWebhookEventStore(undefined, undefined, () => NOW);
  const order: string[] = [];
  const reply = vi.fn<LineReplyClient["reply"]>(async (...args) => {
    order.push("reply");
    return client.reply(...args);
  });
  const notify = notifyOwner ?? vi.fn(async () => void order.push("notify"));
  const deps: ProcessDeps = {
    store,
    client: { reply },
    respond,
    fallbackMessage: DEFAULT_FALLBACK_MESSAGE,
    logger: silentLogger(),
    now: () => NOW,
    notifyOwner: notify,
  };
  return { deps, store, notify, reply, order };
}

const needsOwner: Responder = async () => ({ messages: [{ type: "text", text: "確認します" }], needsOwnerNotification: true });

describe("Webhook 処理からのオーナー通知", () => {
  it("すべてのイベントの返信の後に 1 回だけ呼ぶ（push の待ち時間で返信期限を削らない）", async () => {
    const { deps, notify, order } = setup(needsOwner);
    await processEvents([ev(textEvent()), ev(textEvent()), ev(textEvent())], deps);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["reply", "reply", "reply", "notify"]);
  });

  it("通知が失敗（例外）しても、返信・処理状態の記録の結果は変わらない", async () => {
    const notify = vi.fn(async () => {
      throw new Error("push failed");
    });
    const { deps, store } = setup(needsOwner, notify);
    const e = ev(textEvent());
    expect(await processEvents([e], deps)).toEqual(["replied"]);
    expect(store.entryOf(e.webhookEventId)).toMatchObject({ status: "done", needsOwnerNotification: true });
    expect(deps.logger.error).toHaveBeenCalledWith("[line:webhook] owner notification failed", expect.any(String));
  });

  it("重複・対象外（follow など）のイベントだけなら呼ばない", async () => {
    const { deps } = setup(needsOwner);
    const e = ev(textEvent());
    await processEvents([e], deps);
    const n2 = vi.fn(async () => undefined);
    await processEvents([e, ev(followEvent())], { ...deps, notifyOwner: n2 });
    expect(n2).not.toHaveBeenCalled();
  });

  it("返信に失敗したイベントがあれば呼ぶ（要通知として記録済み）", async () => {
    const failing = { reply: vi.fn(async () => Promise.reject(new Error("timeout"))) } as unknown as LineReplyClient;
    const { deps, notify, store } = setup(echoResponder, undefined, failing);
    const e = ev(textEvent());
    expect(await processEvents([e], deps)).toEqual(["failed"]);
    expect(store.entryOf(e.webhookEventId)?.needsOwnerNotification).toBe(true);
    expect(notify).toHaveBeenCalledWith({ urgent: false });
  });

  it("未設定なら何もしない（従来どおり）", async () => {
    const { deps } = setup(echoResponder);
    expect(await processEvents([ev(textEvent())], { ...deps, notifyOwner: undefined })).toEqual(["replied"]);
  });

  it("店舗全体の AI 利用上限に達したイベントがあれば urgent で呼ぶ", async () => {
    const usage = memoryUsageLimiter({ userPer10Minutes: 5, userPerDay: 30, shopPerDay: 0 });
    const respond = createAiResponder({
      loadShopSettings: async () => shopRow(),
      loadFaqs: async () => FAQS,
      loadMenus: async () => MENUS,
      saveConversation: async () => true,
      model: fakeModel(draft()).model,
      usageLimiter: usage.limiter,
      logger: silentLogger(),
      now: () => NOW,
    });
    const { deps, notify } = setup(respond);
    await processEvents([ev(textEvent())], deps);
    expect(notify).toHaveBeenCalledWith({ urgent: true });
  });

  it("同一ユーザーの連投（user_burst_limit）では通知しない・urgent にもしない", async () => {
    const usage = memoryUsageLimiter({ userPer10Minutes: 0, userPerDay: 30, shopPerDay: 300 });
    const respond = createAiResponder({
      loadShopSettings: async () => shopRow(),
      loadFaqs: async () => FAQS,
      loadMenus: async () => MENUS,
      saveConversation: async () => true,
      model: fakeModel(draft()).model,
      usageLimiter: usage.limiter,
      logger: silentLogger(),
      now: () => NOW,
    });
    const { deps, notify, store } = setup(respond);
    const e = ev(textEvent());
    await processEvents([e], deps);
    expect(store.entryOf(e.webhookEventId)?.needsOwnerNotification).toBe(false);
    // 呼び出し自体はする（過去の未通知分の送信機会）が、urgent ではない
    expect(notify).toHaveBeenCalledWith({ urgent: false });
  });
});
