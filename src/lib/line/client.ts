import type { LineTextMessage } from "./types";

/**
 * LINE への返信クライアント。
 * テスト・ローカルではモック／ドライランを注入し、実送信しない。
 */
export interface LineReplyClient {
  /**
   * 返信する。LINE が受理したら "sent"、送信しなかった（dry-run）なら "simulated" を返す。
   * 失敗時は例外を投げる。
   */
  reply(replyToken: string, messages: LineTextMessage[]): Promise<ReplyDelivery>;
}

/** 返信クライアントの結果。dry-run を送信成功と区別する */
export type ReplyDelivery = "sent" | "simulated";

export class LineApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`LINE API error: ${status}`);
    this.name = "LineApiError";
  }
}

const REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * 実際に LINE Messaging API の応答メッセージ（reply）を送るクライアント。
 * LINE_REPLY_MODE=live かつアクセストークンが設定されている場合のみ使用する（config.ts）。
 */
export function createHttpLineClient(
  channelAccessToken: string,
  fetchImpl: typeof fetch = fetch,
): LineReplyClient {
  return {
    async reply(replyToken, messages) {
      const res = await fetchImpl(REPLY_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${channelAccessToken}`,
        },
        body: JSON.stringify({ replyToken, messages }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        // 応答本文はエラー詳細の把握用に先頭だけ保持（トークン等は含まれない想定）
        throw new LineApiError(res.status, (await res.text()).slice(0, 500));
      }
      return "sent";
    },
  };
}

/**
 * オーナー通知用の push クライアント（WBS 2.5）。
 * 宛先は呼び出し側（owner-notifier）で shop_settings.owner_line_user_id に限定する。お客様への push には使わない。
 */
export interface LinePushClient {
  /**
   * push する。LINE が受理したら "sent"、同じ再送キーで受理済み（409）なら "duplicate"（二重には届かない）。
   * 失敗時は例外（4xx は LineApiError、5xx も LineApiError、通信エラー・タイムアウトはそのままの例外）。
   */
  push(to: string, messages: LineTextMessage[], retryKey: string): Promise<"sent" | "duplicate">;
}

const PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINE_USER_ID = /^U[0-9a-f]{32}$/;

/**
 * LINE Messaging API の push を送るクライアント。LINE_REPLY_MODE=live のときだけ使う（notify/config.ts）。
 * X-Line-Retry-Key（LINE 公式：push で利用可・最初の要求から 24 時間有効・受理済みなら 409）で、
 * 成否不明の再送でも二重に届かないようにする。
 */
export function createHttpLinePushClient(channelAccessToken: string, fetchImpl: typeof fetch = fetch): LinePushClient {
  return {
    async push(to, messages, retryKey) {
      // 宛先・キーの形式が不正なら送らない（設定ミスでの誤送信・LINE 側の 400 を避ける）
      if (!LINE_USER_ID.test(to)) throw new Error("push: invalid destination");
      if (!UUID.test(retryKey)) throw new Error("push: invalid retry key");
      const res = await fetchImpl(PUSH_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${channelAccessToken}`,
          "X-Line-Retry-Key": retryKey,
        },
        body: JSON.stringify({ to, messages }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 409) return "duplicate";
      if (!res.ok) throw new LineApiError(res.status, (await res.text()).slice(0, 500));
      return "sent";
    },
  };
}

/** 送信せず、送信内容の概要だけをログに出すクライアント（既定） */
export function createDryRunLineClient(log: (msg: string) => void = console.info): LineReplyClient {
  return {
    async reply(_replyToken, messages) {
      log(
        `[line:dry-run] reply skipped (${messages.length} message(s), ` +
          `${messages.reduce((n, m) => n + m.text.length, 0)} chars)`,
      );
      return "simulated";
    },
  };
}
