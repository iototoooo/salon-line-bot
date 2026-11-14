import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * LINE Messaging API の Webhook 署名（x-line-signature）を検証する。
 *
 * 署名 = Base64( HMAC-SHA256( チャネルシークレット, リクエスト本文の生バイト列 ) )
 *
 * - 本文は JSON.parse 前の「生のバイト列」を渡すこと（再シリアライズすると一致しない）
 * - 比較は timingSafeEqual で行い、タイミング攻撃を避ける
 */
export function verifyLineSignature(
  rawBody: Uint8Array,
  signature: string | null | undefined,
  channelSecret: string,
): boolean {
  if (!channelSecret) return false;
  if (typeof signature !== "string" || signature.length === 0) return false;

  const expected = createHmac("sha256", channelSecret).update(rawBody).digest();

  // Buffer.from は不正な Base64 でも例外を投げないため、長さと正規表現の一致で判定する
  const received = Buffer.from(signature, "base64");
  if (received.length !== expected.length) return false;
  // 余分な文字を含む署名を排除（正規の Base64 表現と一致するか）
  if (received.toString("base64") !== signature) return false;

  return timingSafeEqual(received, expected);
}

/** テスト・ローカル検証用：本文から署名を生成する */
export function createLineSignature(rawBody: Uint8Array | string, channelSecret: string): string {
  return createHmac("sha256", channelSecret).update(rawBody).digest("base64");
}
