import { describe, expect, it, vi } from "vitest";
import { CONFIRMATION_NEEDED_MESSAGE } from "@/lib/ai/answer";
import { USAGE_LIMIT_MESSAGE, USER_USAGE_LIMIT_MESSAGE } from "@/lib/ai/usage-limit";
import { type AiResponderDeps, createAiResponder } from "@/lib/bot/ai-responder";
import { InMemoryWebhookEventStore } from "@/lib/line/event-store";
import { parseEvent } from "@/lib/line/parse";
import {
  DEFAULT_FALLBACK_MESSAGE,
  NON_TEXT_REPLY,
  processEvents,
  type ResponderResult,
} from "@/lib/line/process-events";
import { createWebhookHandler } from "@/lib/line/webhook-handler";
import type { LineNonTextMessageEvent, LineTextMessageEvent, LineWebhookEvent } from "@/lib/line/types";
import type { ConversationInsert } from "@/types/database";
import { memoryUsageLimiter } from "../ai/fake-usage-limiter";
import { draft, FAQS, fakeModel, MENU_IDS, MENUS, shopRow } from "../ai/fixtures";
import { body, mockClient, NOW, signedRequest, silentLogger, stickerEvent, TEST_SECRET, textEvent, USER_ID } from "../line/fixtures";

// Claude・LINE・Supabase はすべてモック（実際の API・DB は使わない）

const ev = (raw: unknown) => {
  const e = parseEvent(raw);
  if (!e) throw new Error("fixture is invalid");
  return e as LineTextMessageEvent | LineNonTextMessageEvent;
};

const priceAnswer = draft({ answer: "カットは 4,400円です。", category: "price", menu_refs: ["M1"] });

function setup(over: Partial<AiResponderDeps> = {}, output: unknown = priceAnswer) {
  const { model, generate } = fakeModel(output);
  const usage = memoryUsageLimiter();
  const saved: ConversationInsert[] = [];
  const logger = silentLogger();
  const deps: AiResponderDeps = {
    usageLimiter: usage.limiter,
    loadShopSettings: vi.fn(async () => shopRow()),
    loadFaqs: vi.fn(async () => FAQS),
    loadMenus: vi.fn(async () => MENUS),
    saveConversation: vi.fn(async (row: ConversationInsert) => {
      saved.push(row);
      return true;
    }),
    model,
    logger,
    now: () => 0,
    ...over,
  };
  return { respond: createAiResponder(deps), deps, generate, saved, logger, usage };
}

async function run(respond: ReturnType<typeof createAiResponder>, raw: unknown) {
  return (await respond(ev(raw))) as ResponderResult;
}

describe("AI 応答の Responder", () => {
  it("bot_enabled=false：AI を呼ばず、店舗の定型文だけを返し、bot_off として記録する", async () => {
    const { respond, generate, deps, saved } = setup({
      loadShopSettings: vi.fn(async () => shopRow({ bot_enabled: false, fallback_message: "ただいま自動応答を停止しています。" })),
    });
    const r = await run(respond, textEvent({ message: { id: "1", type: "text", text: "カットはいくら？" } }));
    expect(generate).not.toHaveBeenCalled();
    expect(deps.loadFaqs).not.toHaveBeenCalled();
    expect(r.messages).toEqual([{ type: "text", text: "ただいま自動応答を停止しています。" }]);
    await r.afterReply!("simulated", []);
    expect(saved[0]).toMatchObject({ ai_status: "bot_off", needs_owner: true, model: null, reply_method: "none" });
  });

  it("回答できた場合：会話ログに状態・根拠・トークン数を記録する（dry-run は reply_method=none）", async () => {
    const { respond, saved } = setup();
    const e = textEvent({ message: { id: "1", type: "text", text: "カットはいくら？" } });
    const r = await run(respond, e);
    expect(r.messages).toEqual([{ type: "text", text: "カットは 4,400円です。" }]);
    expect(r.needsOwnerNotification).toBe(false);
    await r.afterReply!("simulated", []);
    expect(saved[0]).toEqual({
      line_event_id: e.webhookEventId,
      line_user_id: USER_ID,
      message_type: "text",
      user_message: "カットはいくら？",
      ai_status: "answered",
      ai_category: "price",
      bot_reply: "カットは 4,400円です。",
      reply_method: "none",
      needs_owner: false,
      model: "claude-haiku-5-5",
      input_tokens: 1200,
      output_tokens: 80,
      latency_ms: 0,
      error_message: null,
      source_faq_ids: [],
      source_menu_ids: [MENU_IDS.cut],
      source_shop_fields: [],
      ai_reason: null,
    });
  });

  it("実際に送信できた場合は reply_method=reply", async () => {
    const { respond, saved } = setup();
    await (await run(respond, textEvent())).afterReply!("sent", []);
    expect(saved[0].reply_method).toBe("reply");
  });

  it("回答不能：「確認が必要です」と要オーナー対応・理由を記録する", async () => {
    const { respond, saved } = setup({}, draft({ status: "cannot_answer", reason: "店販商品の登録なし" }));
    const r = await run(respond, textEvent({ message: { id: "1", type: "text", text: "シャンプー売ってますか" } }));
    expect(r.messages[0].text).toBe(CONFIRMATION_NEEDED_MESSAGE);
    expect(r.needsOwnerNotification).toBe(true);
    await r.afterReply!("simulated", []);
    expect(saved[0]).toMatchObject({ ai_status: "cannot_answer", needs_owner: true, ai_reason: "店販商品の登録なし" });
  });

  it("予約の質問：予約案内を返し、reservation として記録する", async () => {
    const { respond, saved } = setup({}, draft({ status: "reservation", category: "reservation" }));
    const r = await run(respond, textEvent({ message: { id: "1", type: "text", text: "明日空いてますか" } }));
    await r.afterReply!("simulated", []);
    expect(saved[0]).toMatchObject({ ai_status: "reservation", ai_category: "reservation", source_shop_fields: ["reservation_guide"] });
  });

  it("テキスト以外：AI を呼ばず定型文、unsupported・要オーナー対応", async () => {
    const { respond, generate, saved } = setup();
    const r = await run(respond, stickerEvent());
    expect(generate).not.toHaveBeenCalled();
    expect(r.messages[0].text).toBe(NON_TEXT_REPLY);
    await r.afterReply!("simulated", []);
    expect(saved[0]).toMatchObject({ ai_status: "unsupported", message_type: "sticker", user_message: null, needs_owner: true });
  });

  it("店舗情報を読めない：AI を呼ばず既定の定型文・error", async () => {
    const { respond, generate, saved } = setup({ loadShopSettings: vi.fn(async () => Promise.reject(new Error("db down"))) });
    const r = await run(respond, textEvent());
    expect(generate).not.toHaveBeenCalled();
    expect(r.messages[0].text).toBe(DEFAULT_FALLBACK_MESSAGE);
    await r.afterReply!("simulated", []);
    expect(saved[0]).toMatchObject({ ai_status: "error", error_message: "shop_settings_unavailable", needs_owner: true });
  });

  it("FAQ・メニューを読めない：AI を呼ばず店舗の定型文・error", async () => {
    const { respond, generate } = setup({ loadMenus: vi.fn(async () => Promise.reject(new Error("db down"))) });
    const r = await run(respond, textEvent());
    expect(generate).not.toHaveBeenCalled();
    expect(r.messages[0].text).toBe(shopRow().fallback_message);
  });

  it("API キー未設定（model=null）：定型文・error（AC-10）", async () => {
    const { respond, saved } = setup({ model: null });
    const r = await run(respond, textEvent());
    expect(r.messages[0].text).toBe(shopRow().fallback_message);
    await r.afterReply!("simulated", []);
    expect(saved[0]).toMatchObject({ ai_status: "error", error_message: "ai_not_configured" });
  });

  it("返信に失敗した場合は要オーナー対応にし、結果コードを残す", async () => {
    const { respond, saved } = setup();
    await (await run(respond, textEvent())).afterReply!("failed", []);
    expect(saved[0]).toMatchObject({ ai_status: "answered", needs_owner: true, reply_method: "none", error_message: "reply_failed" });
  });

  it("会話ログの保存に失敗しても例外にしない。ログに本文・userId を出さない", async () => {
    const { respond, logger } = setup({ saveConversation: vi.fn(async () => Promise.reject(new Error("insert failed"))) });
    const r = await run(respond, textEvent({ message: { id: "1", type: "text", text: "秘密の相談です" } }));
    await expect(r.afterReply!("simulated", [])).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toContain("秘密の相談");
    expect(logged).not.toContain(USER_ID);
  });

  it("返信期限までの残り時間が足りなければ AI を呼ばない（費用だけかかって返信できない事態を防ぐ）", async () => {
    const { respond, generate, saved } = setup({ now: () => NOW + 40_000 });
    const r = await run(respond, textEvent());
    expect(generate).not.toHaveBeenCalled();
    expect(r.messages[0].text).toBe(shopRow().fallback_message);
    await r.afterReply!("simulated", r.messages);
    expect(saved[0]).toMatchObject({ ai_status: "error", error_message: "reply_deadline_too_close", needs_owner: true });
  });

  it("会話ログの返信文は実際に送った文（定型文に置き換えた場合はそちら）を記録する", async () => {
    const { respond, saved } = setup();
    await (await run(respond, textEvent())).afterReply!("sent", [{ type: "text", text: DEFAULT_FALLBACK_MESSAGE }]);
    expect(saved[0].bot_reply).toBe(DEFAULT_FALLBACK_MESSAGE);
  });

  it("判定理由に含まれる電話番号は伏せて保存する", async () => {
    const { respond, saved } = setup({}, draft({ status: "cannot_answer", reason: "お客様（090-1234-5678）からの店販の質問" }));
    await (await run(respond, textEvent())).afterReply!("simulated", []);
    expect(saved[0].ai_reason).toBe("お客様（[電話番号省略]）からの店販の質問");
  });

  it("userId の形式が想定外なら会話ログを保存しない", async () => {
    const { respond, saved } = setup();
    await (await run(respond, textEvent({ source: { type: "user", userId: "not-a-line-user" } }))).afterReply!("simulated", []);
    expect(saved).toEqual([]);
  });
});

describe("利用回数制限（Responder）", () => {
  const text = (t = "カットはいくら？") => textEvent({ message: { id: "1", type: "text", text: t } });

  it("同一ユーザーが 10 分間に 6 回送ると、6 回目は AI を呼ばず定型文。理由をコードで記録し、オーナー対応にはしない", async () => {
    const { respond, generate, saved } = setup();
    const results: ResponderResult[] = [];
    for (let i = 0; i < 6; i++) results.push(await run(respond, text()));
    expect(generate).toHaveBeenCalledTimes(5);
    expect(results[5].messages[0].text).toBe(USER_USAGE_LIMIT_MESSAGE);
    expect(results[5].needsOwnerNotification).toBe(false);
    await results[5].afterReply!("simulated", results[5].messages);
    expect(saved[0]).toMatchObject({
      ai_status: "error",
      error_message: "usage_user_burst_limit",
      needs_owner: false,
      model: null,
      input_tokens: null,
    });
  });

  it("店舗全体の上限に達すると、別のユーザーでも AI を呼ばない", async () => {
    const usage = memoryUsageLimiter({ userPer10Minutes: 5, userPerDay: 30, shopPerDay: 2 });
    const { respond, generate } = setup({ usageLimiter: usage.limiter });
    await run(respond, text());
    await run(respond, textEvent({ source: { type: "user", userId: `U${"1".repeat(32)}` } }));
    const third = await run(respond, textEvent({ source: { type: "user", userId: `U${"2".repeat(32)}` } }));
    expect(generate).toHaveBeenCalledTimes(2);
    expect(third.messages[0].text).toBe(USAGE_LIMIT_MESSAGE);
    expect(third.needsOwnerNotification).toBe(true);
  });

  it("並列に届いた 10 件でも、AI の呼び出しは上限の 5 回まで", async () => {
    const { respond, generate, usage } = setup();
    const results = await Promise.all(Array.from({ length: 10 }, () => run(respond, text())));
    expect(generate).toHaveBeenCalledTimes(5);
    expect(usage.records).toHaveLength(5);
    expect(results.filter((r) => r.messages[0].text === USER_USAGE_LIMIT_MESSAGE)).toHaveLength(5);
  });

  it("利用枠を確認できない（DB エラー）場合は AI を呼ばず定型文", async () => {
    const reserve = vi.fn(async () => Promise.reject(new Error("db down")));
    const { respond, generate, saved } = setup({ usageLimiter: { reserve } });
    const r = await run(respond, text());
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(r.messages[0].text).toBe(USAGE_LIMIT_MESSAGE);
    await r.afterReply!("simulated", r.messages);
    expect(saved[0]).toMatchObject({ ai_status: "error", error_message: "usage_check_failed", needs_owner: true });
  });

  it("同じイベントの利用枠が確保済み（duplicate）なら AI を呼ばない", async () => {
    const { respond, generate, usage } = setup();
    const e = text();
    await usage.limiter.reserve({ webhookEventId: e.webhookEventId, lineUserId: USER_ID });
    const r = await run(respond, e);
    expect(generate).not.toHaveBeenCalled();
    expect(r.messages[0].text).toBe(USAGE_LIMIT_MESSAGE);
  });

  it.each([
    ["bot_enabled=false", { loadShopSettings: vi.fn(async () => shopRow({ bot_enabled: false })) }, text()],
    ["テキスト以外", {}, stickerEvent()],
    ["返信期限が近い", { now: () => NOW + 40_000 }, text()],
    ["API キー未設定", { model: null }, text()],
  ] as const)("%s：AI を呼ばないので利用枠も消費しない", async (_l, over, raw) => {
    const { respond, usage } = setup(over as Partial<AiResponderDeps>);
    await run(respond, raw);
    expect(usage.reserve).not.toHaveBeenCalled();
  });

  it("利用枠の確保には webhookEventId と LINE ユーザー ID を渡す。ログには ID を出さない", async () => {
    const { respond, usage, logger } = setup();
    const e = text();
    await run(respond, e);
    expect(usage.reserve).toHaveBeenCalledWith({ webhookEventId: e.webhookEventId, lineUserId: USER_ID });
    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toContain(USER_ID);
  });

  it("ユーザー ID の形式が想定外なら利用枠を確保せず、AI を呼ばない", async () => {
    const { respond, generate, usage } = setup();
    const r = await run(respond, textEvent({ source: { type: "user", userId: "not-a-line-user" } }));
    expect(usage.reserve).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(r.messages[0].text).toBe(USAGE_LIMIT_MESSAGE);
  });
});

describe("Webhook 処理との連携（LINE はモック）", () => {
  const procDeps = (respond: ReturnType<typeof createAiResponder>) => {
    const store = new InMemoryWebhookEventStore(undefined, undefined, () => NOW);
    const client = mockClient();
    return {
      store,
      client,
      deps: { store, client, respond, fallbackMessage: DEFAULT_FALLBACK_MESSAGE, logger: silentLogger(), now: () => NOW },
    };
  };

  it("AI の回答を返信し、会話ログを保存する。回答不能は要通知として処理状態にも記録する", async () => {
    const { respond, saved } = setup({}, draft({ status: "cannot_answer" }));
    const { store, client, deps } = procDeps(respond);
    const e = ev(textEvent());
    expect(await processEvents([e], deps)).toEqual(["replied"]);
    expect(client.reply).toHaveBeenCalledWith(e.replyToken, [{ type: "text", text: CONFIRMATION_NEEDED_MESSAGE }]);
    expect(saved).toHaveLength(1);
    expect(saved[0].reply_method).toBe("reply");
    expect(store.entryOf(e.webhookEventId)).toMatchObject({ status: "done", needsOwnerNotification: true });
  });

  it("重複したイベントは AI も返信も会話ログも 1 回だけ", async () => {
    const { respond, generate, saved } = setup();
    const { client, deps } = procDeps(respond);
    const raw = textEvent();
    const outcomes = await processEvents([ev(raw), ev({ ...raw, deliveryContext: { isRedelivery: true } })], deps);
    expect(outcomes).toEqual(["replied", "duplicate"]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(client.reply).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(1);
  });

  it("返信期限切れで送れなかった場合も会話ログに not_sent として残す", async () => {
    const { respond, saved } = setup();
    const { client, deps } = procDeps(respond);
    const e = ev(textEvent());
    await deps.store.claim({ webhookEventId: e.webhookEventId, eventType: "message", isRedelivery: false, eventTimestamp: NOW });
    await deps.store.beginReply(e.webhookEventId); // 既に返信トークンを使用済み
    expect(await processEvents([e], deps, { alreadyClaimed: true })).toEqual(["reply_not_allowed"]);
    expect(client.reply).not.toHaveBeenCalled();
    expect(saved[0]).toMatchObject({ needs_owner: true, reply_method: "none", error_message: "reply_not_sent" });
  });

  it("署名付きリクエスト → AI 応答。同じ本文の再送では 2 回目を処理しない", async () => {
    const { respond, generate } = setup();
    const { store, client, deps } = procDeps(respond);
    const tasks: Array<() => Promise<void>> = [];
    const handler = createWebhookHandler(() => ({
      channelSecret: TEST_SECRET,
      schedule: (t) => tasks.push(t),
      claimEvents: async (events: LineWebhookEvent[]) => {
        const claimed: LineWebhookEvent[] = [];
        for (const e of events) {
          if (await store.claim({ webhookEventId: e.webhookEventId, eventType: "message", isRedelivery: e.isRedelivery })) claimed.push(e);
        }
        return { claimed };
      },
      processEvents: (events) => processEvents(events, deps, { alreadyClaimed: true }),
      logger: silentLogger(),
    }));
    const raw = body([textEvent()]);
    expect((await handler(signedRequest(raw))).status).toBe(200);
    expect((await handler(signedRequest(raw))).status).toBe(200);
    // 不正な署名は AI まで到達しない
    expect((await handler(signedRequest(raw, "wrong-secret"))).status).toBe(401);
    for (const t of tasks) await t();
    expect(tasks).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(client.reply).toHaveBeenCalledTimes(1);
  });
});
