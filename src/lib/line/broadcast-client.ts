import { LineApiError } from "./client";
import type { LineTextMessage } from "./types";

/**
 * 一斉配信（WBS 3.6）で使う LINE Messaging API（サーバー専用）。
 *
 * - 送信数の確認（GET）：今月の上限・今月の送信数・友だち数（配信対象の目安）
 * - 一斉配信（POST /v2/bot/message/broadcast）：X-Line-Retry-Key で冪等化。受理済みなら 409（二重に届かない）
 * 料金・無料枠：日本のコミュニケーションプラン（無料）は月 200 通まで。broadcast は「送った人数」で数える（LINE 公式ドキュメント）。
 * 実際に送信するかどうか（安全スイッチ）は呼び出し側（src/lib/admin/broadcast-actions.ts）で判定する。
 */
const API = "https://api.line.me";
const TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MessageQuota = { type: "none" } | { type: "limited"; value: number };
export type FollowerInsight = {
  /** ready 以外（集計中・対象外）は人数を使わない */
  status: string;
  followers: number | null;
  /** 配信対象になる人数（ブロック・属性などを除いた数）。LINE の集計値 */
  targetedReaches: number | null;
  blocks: number | null;
};

export interface LineBroadcastApi {
  getQuota(): Promise<MessageQuota>;
  getConsumption(): Promise<number>;
  /** date は日本時間の YYYYMMDD（前日分まで集計される） */
  getFollowers(date: string): Promise<FollowerInsight>;
  broadcast(messages: LineTextMessage[], retryKey: string): Promise<"sent" | "duplicate">;
}

export function createLineBroadcastApi(channelAccessToken: string, fetchImpl: typeof fetch = fetch): LineBroadcastApi {
  const headers = { Authorization: `Bearer ${channelAccessToken}` };

  async function getJson(path: string): Promise<Record<string, unknown>> {
    const res = await fetchImpl(API + path, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new LineApiError(res.status, (await res.text()).slice(0, 500));
    return (await res.json()) as Record<string, unknown>;
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  return {
    async getQuota() {
      const b = await getJson("/v2/bot/message/quota");
      if (b.type === "none") return { type: "none" };
      const value = num(b.value);
      if (b.type === "limited" && value !== null) return { type: "limited", value };
      throw new Error("line: unexpected quota response");
    },
    async getConsumption() {
      const total = num((await getJson("/v2/bot/message/quota/consumption")).totalUsage);
      if (total === null) throw new Error("line: unexpected consumption response");
      return total;
    },
    async getFollowers(date) {
      if (!/^\d{8}$/.test(date)) throw new Error("line: invalid date");
      const b = await getJson(`/v2/bot/insight/followers?date=${date}`);
      return {
        status: typeof b.status === "string" ? b.status : "unknown",
        followers: num(b.followers),
        targetedReaches: num(b.targetedReaches),
        blocks: num(b.blocks),
      };
    },
    async broadcast(messages, retryKey) {
      if (!UUID.test(retryKey)) throw new Error("broadcast: invalid retry key");
      if (messages.length === 0 || messages.length > 5) throw new Error("broadcast: invalid message count");
      const res = await fetchImpl(`${API}/v2/bot/message/broadcast`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json", "X-Line-Retry-Key": retryKey },
        body: JSON.stringify({ messages }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 409) return "duplicate";
      if (!res.ok) throw new LineApiError(res.status, (await res.text()).slice(0, 500));
      return "sent";
    },
  };
}
