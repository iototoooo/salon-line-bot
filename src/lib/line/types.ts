/**
 * LINE Webhook のうち、本システムで扱う範囲の型。
 * 未知のフィールドは無視し、必要な項目だけを検証して取り出す（parse.ts）。
 */

export type LineSource =
  | { type: "user"; userId: string }
  | { type: "group" | "room" | "unknown" };

type LineEventBase = {
  webhookEventId: string;
  timestamp: number;
  /** "active" 以外（"standby" 等）では返信しない */
  mode: string;
  isRedelivery: boolean;
  source: LineSource;
};

export type LineTextMessageEvent = LineEventBase & {
  kind: "text";
  replyToken: string;
  messageId: string;
  text: string;
};

export type LineNonTextMessageEvent = LineEventBase & {
  kind: "non_text_message";
  replyToken: string;
  messageId: string;
  /** image / video / audio / file / location / sticker など */
  messageType: string;
};

/** follow / unfollow / postback など、本システムで返信しないイベント */
export type LineOtherEvent = LineEventBase & {
  kind: "other";
  eventType: string;
};

export type LineWebhookEvent = LineTextMessageEvent | LineNonTextMessageEvent | LineOtherEvent;

export type ParsedWebhookBody = {
  destination: string;
  events: LineWebhookEvent[];
  /** 必須項目が不足し、処理対象から除外したイベント数 */
  invalidEventCount: number;
};

export type LineTextMessage = { type: "text"; text: string };
