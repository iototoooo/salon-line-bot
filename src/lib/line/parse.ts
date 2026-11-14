import type { LineSource, LineWebhookEvent, ParsedWebhookBody } from "./types";

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export type ParseResult =
  | { ok: true; body: ParsedWebhookBody }
  | { ok: false; error: "invalid_json" | "invalid_body" };

/**
 * 署名検証済みの本文を解析する。
 * - JSON として不正 → invalid_json
 * - destination / events が不正 → invalid_body
 * - 個々のイベントの必須項目不足 → そのイベントだけ除外（他のイベントは処理する）
 */
export function parseWebhookBody(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_json" };
  }

  if (!isRecord(json) || typeof json.destination !== "string" || !Array.isArray(json.events)) {
    return { ok: false, error: "invalid_body" };
  }

  const events: LineWebhookEvent[] = [];
  let invalidEventCount = 0;
  for (const raw of json.events) {
    const event = parseEvent(raw);
    if (event) events.push(event);
    else invalidEventCount++;
  }

  return { ok: true, body: { destination: json.destination, events, invalidEventCount } };
}

function parseSource(v: unknown): LineSource | null {
  if (!isRecord(v) || typeof v.type !== "string") return null;
  if (v.type === "user") {
    return nonEmptyString(v.userId) ? { type: "user", userId: v.userId } : null;
  }
  if (v.type === "group" || v.type === "room") return { type: v.type };
  return { type: "unknown" };
}

export function parseEvent(raw: unknown): LineWebhookEvent | null {
  if (!isRecord(raw)) return null;
  const { webhookEventId, type, timestamp, mode, deliveryContext } = raw;

  if (!nonEmptyString(webhookEventId) || webhookEventId.length > 100) return null;
  if (!nonEmptyString(type)) return null;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  if (!nonEmptyString(mode)) return null;
  if (!isRecord(deliveryContext) || typeof deliveryContext.isRedelivery !== "boolean") return null;

  const source = parseSource(raw.source);
  if (!source) return null;

  const base = {
    webhookEventId,
    timestamp,
    mode,
    isRedelivery: deliveryContext.isRedelivery,
    source,
  };

  if (type !== "message") {
    return { ...base, kind: "other", eventType: type };
  }

  const { replyToken, message } = raw;
  if (!nonEmptyString(replyToken)) return null;
  if (!isRecord(message) || !nonEmptyString(message.id) || !nonEmptyString(message.type)) return null;

  if (message.type === "text") {
    if (typeof message.text !== "string") return null;
    return { ...base, kind: "text", replyToken, messageId: message.id, text: message.text };
  }

  return {
    ...base,
    kind: "non_text_message",
    replyToken,
    messageId: message.id,
    messageType: message.type,
  };
}
