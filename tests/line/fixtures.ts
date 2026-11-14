import { vi } from "vitest";
import type { LineReplyClient } from "@/lib/line/client";
import { createLineSignature } from "@/lib/line/signature";

/** テスト専用のダミー値（実際の認証情報ではない） */
export const TEST_SECRET = "test-channel-secret-not-real";
export const USER_ID = `U${"0".repeat(32)}`;
export const NOW = 1_762_750_000_000;

let seq = 0;
export function textEvent(overrides: Record<string, unknown> = {}) {
  seq++;
  return {
    type: "message",
    mode: "active",
    timestamp: NOW,
    source: { type: "user", userId: USER_ID },
    webhookEventId: `01TESTEVENT${String(seq).padStart(15, "0")}`,
    deliveryContext: { isRedelivery: false },
    replyToken: `reply-token-${seq}`,
    message: { id: `${100000 + seq}`, type: "text", quoteToken: "q", text: "営業時間は？" },
    ...overrides,
  };
}

export function stickerEvent(overrides: Record<string, unknown> = {}) {
  return textEvent({
    message: { id: "200001", type: "sticker", packageId: "446", stickerId: "1988", stickerResourceType: "STATIC" },
    ...overrides,
  });
}

export function followEvent() {
  return textEvent({ type: "follow", message: undefined });
}

export function body(events: unknown[]) {
  return JSON.stringify({ destination: "Uffffffffffffffffffffffffffffffff", events });
}

export function signedRequest(rawBody: string, secret = TEST_SECRET, signature?: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const sig = signature === undefined ? createLineSignature(rawBody, secret) : signature;
  if (sig !== null) headers["x-line-signature"] = sig;
  return new Request("http://localhost/api/line/webhook", { method: "POST", headers, body: rawBody });
}

export function mockClient() {
  // 実送信（live）のクライアントを模したモック。LINE が受理した想定で "sent" を返す
  const reply = vi.fn<LineReplyClient["reply"]>(async () => "sent");
  return { reply };
}

export function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
