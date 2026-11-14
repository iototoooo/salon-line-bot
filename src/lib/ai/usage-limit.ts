/**
 * Claude API の利用回数制限（6 本目のマイグレーション：public.reserve_ai_usage）。
 *
 * AI を呼び出す直前に利用枠を確保し、'reserved' のときだけ AI を呼ぶ。
 * 確認と確保は DB 関数の中で原子的に行う（同時に届いた Webhook でも上限を超えない）。
 *
 * これは呼び出し回数の上限であり、請求金額の上限を保証するものではない
 * （1 回あたりの費用は質問・登録情報の長さで変わる。金額の上限は Anthropic の管理画面の利用上限で設定する）。
 */

/** 初期値（日本時間基準） */
export const AI_USAGE_LIMITS = {
  /** 同一 LINE ユーザー：直近 10 分間 */
  userPer10Minutes: 5,
  /** 同一 LINE ユーザー：日本時間の 1 日 */
  userPerDay: 30,
  /** 店舗全体：日本時間の 1 日 */
  shopPerDay: 300,
} as const;

export const USAGE_RESERVATIONS = [
  "reserved",
  "duplicate",
  "user_burst_limit",
  "user_daily_limit",
  "shop_daily_limit",
] as const;
export type UsageReservation = (typeof USAGE_RESERVATIONS)[number];

export function isUsageReservation(v: unknown): v is UsageReservation {
  return typeof v === "string" && (USAGE_RESERVATIONS as readonly string[]).includes(v);
}

export type UsageReservationInput = {
  webhookEventId: string;
  /** LINE ユーザー ID（DB にはハッシュ値だけが保存される）。ログには出さない */
  lineUserId: string;
};

export interface AiUsageLimiter {
  /** 利用枠を確認・確保する。確認できない場合は例外（呼び出し側は AI を呼ばない） */
  reserve(input: UsageReservationInput): Promise<UsageReservation>;
}

/**
 * 上限到達・確認失敗のときにお客様へ返す定型文。
 * 上限の値や理由は書かない（悪用の手がかりにしないため）。返信が途切れないよう、担当者からの連絡を案内する。
 */
export const USAGE_LIMIT_MESSAGE =
  "お問い合わせありがとうございます。ただいま自動応答でお答えできないため、担当者が確認のうえ、改めてご連絡いたします。";

/**
 * 同一ユーザーの上限（10 分間・1 日）に達したときの定型文。
 * 連投のたびにオーナー対応にすると通知が埋もれるため、担当者からの連絡は約束せず、時間をおくか電話を案内する。
 */
export const USER_USAGE_LIMIT_MESSAGE =
  "お問い合わせありがとうございます。短時間に多くのメッセージをいただいたため、自動応答を一時的に停止しています。お手数ですが、時間をおいて再度お送りいただくか、お電話でお問い合わせください。";

/**
 * 理由ごとの扱い。
 *   needsOwner: true  → 会話ログで要オーナー対応にする（店舗全体の上限・確認失敗：一般のお客様に影響するため）
 *   needsOwner: false → 記録のみ（同一ユーザーの連投・同じイベントの再処理：通知の大量発生を防ぐ）
 */
export function usageBlockPolicy(code: Exclude<UsageReservation, "reserved"> | "check_failed") {
  switch (code) {
    case "user_burst_limit":
    case "user_daily_limit":
      return { message: USER_USAGE_LIMIT_MESSAGE, needsOwner: false };
    case "duplicate":
      return { message: USAGE_LIMIT_MESSAGE, needsOwner: false };
    case "shop_daily_limit":
    case "check_failed":
      return { message: USAGE_LIMIT_MESSAGE, needsOwner: true };
  }
}
