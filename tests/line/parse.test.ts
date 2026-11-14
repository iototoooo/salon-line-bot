import { describe, expect, it } from "vitest";
import { parseWebhookBody } from "@/lib/line/parse";
import { body, followEvent, stickerEvent, textEvent, USER_ID } from "./fixtures";

describe("parseWebhookBody", () => {
  it("不正な JSON は invalid_json", () => {
    expect(parseWebhookBody("{not json")).toEqual({ ok: false, error: "invalid_json" });
  });

  it.each([
    ["配列", "[]"],
    ["events なし", '{"destination":"U1"}'],
    ["events が配列でない", '{"destination":"U1","events":{}}'],
    ["destination なし", '{"events":[]}'],
  ])("本文の形が不正（%s）なら invalid_body", (_l, raw) => {
    expect(parseWebhookBody(raw)).toEqual({ ok: false, error: "invalid_body" });
  });

  it("events が空でも受け入れる（LINE の検証リクエスト）", () => {
    const r = parseWebhookBody(body([]));
    expect(r.ok && r.body.events).toEqual([]);
  });

  it("テキストメッセージを取り出す", () => {
    const ev = textEvent();
    const r = parseWebhookBody(body([ev]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.events[0]).toMatchObject({
      kind: "text",
      webhookEventId: ev.webhookEventId,
      replyToken: ev.replyToken,
      text: "営業時間は？",
      isRedelivery: false,
      source: { type: "user", userId: USER_ID },
    });
  });

  it("スタンプは non_text_message になる", () => {
    const r = parseWebhookBody(body([stickerEvent()]));
    expect(r.ok && r.body.events[0]).toMatchObject({ kind: "non_text_message", messageType: "sticker" });
  });

  it("follow など message 以外は other になる", () => {
    const r = parseWebhookBody(body([followEvent()]));
    expect(r.ok && r.body.events[0]).toMatchObject({ kind: "other", eventType: "follow" });
  });

  it.each([
    ["webhookEventId なし", { webhookEventId: undefined }],
    ["deliveryContext なし", { deliveryContext: undefined }],
    ["isRedelivery が真偽値でない", { deliveryContext: { isRedelivery: "no" } }],
    ["timestamp なし", { timestamp: undefined }],
    ["mode なし", { mode: undefined }],
    ["source なし", { source: undefined }],
    ["user なのに userId なし", { source: { type: "user" } }],
    ["replyToken なし", { replyToken: undefined }],
    ["message なし", { message: undefined }],
    ["text が文字列でない", { message: { id: "1", type: "text", text: 123 } }],
    ["message.id なし", { message: { type: "text", text: "a" } }],
  ])("必須項目が不足したイベント（%s）は除外し、件数を数える", (_l, override) => {
    const good = textEvent();
    const bad = textEvent(override);
    const r = parseWebhookBody(body([bad, good]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.invalidEventCount).toBe(1);
    expect(r.body.events.map((e) => e.webhookEventId)).toEqual([good.webhookEventId]);
  });

  it("未知のフィールドがあっても処理できる", () => {
    const r = parseWebhookBody(body([textEvent({ futureField: { a: 1 } })]));
    expect(r.ok && r.body.events).toHaveLength(1);
  });
});
