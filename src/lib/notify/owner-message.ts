import { maskPersonalInfo } from "@/lib/ai/guard";

/**
 * オーナー通知の本文を組み立てる（WBS 2.5 / F-12）。
 *
 * 含めるもの：受信日時（日本時間）・対応が必要な理由・質問の先頭部分（電話番号・メール等は伏せる）・未対応一覧へのリンク
 * 含めないもの：LINE ユーザー ID・表示名・AI の回答文・エラーの詳細
 * 1 通にまとめ、詳細は新しい順に最大 MAX_LISTED_ITEMS 件。残りは「ほか N 件」とする。
 */

export const MAX_LISTED_ITEMS = 5;
/** 質問の先頭部分の文字数（要約として最小限にする） */
export const EXCERPT_CHARS = 20;
/** LINE テキストメッセージの上限（5,000 文字）より十分短く */
const MAX_NOTIFICATION_CHARS = 2000;

export type NotificationCategory =
  | "cannot_answer"
  | "reservation_change"
  | "unsupported"
  | "bot_off"
  | "ai_error"
  | "usage_shop_limit"
  | "usage_check_failed"
  | "reply_failed"
  | "stalled"
  | "system_error";

const LABELS: Record<NotificationCategory, string> = {
  cannot_answer: "確認が必要な質問",
  reservation_change: "予約の変更・キャンセルのご連絡",
  unsupported: "画像・スタンプなど",
  bot_off: "自動応答 OFF 中のお問い合わせ",
  ai_error: "AI 処理エラー（定型文で返信済み）",
  usage_shop_limit: "AI 利用上限のため定型文で返信",
  usage_check_failed: "AI 利用枠の確認エラー（定型文で返信済み）",
  reply_failed: "返信の送信に失敗",
  stalled: "処理が途中で停止",
  system_error: "システムエラー",
};

/** 会話ログ（あれば）とイベントの記録から取り出した、通知 1 件分の情報 */
export type NotificationSource = {
  eventId: string;
  /** ISO 形式の受信日時 */
  receivedAt: string;
  conversation: {
    aiStatus: string;
    /** 処理結果コード（usage_shop_daily_limit・reply_failed など。個人情報を含まない） */
    errorMessage: string | null;
    userMessage: string | null;
  } | null;
  event: { status: string; lastError: string | null } | null;
};

export type NotificationItem = {
  eventId: string;
  receivedAt: string;
  category: NotificationCategory;
  /** 質問の先頭部分（伏せ字済み）。テキスト以外・会話ログがない場合は null */
  excerpt: string | null;
};

export function classify(source: NotificationSource): NotificationCategory {
  const c = source.conversation;
  if (c) {
    const codes = (c.errorMessage ?? "").split(/\s+/);
    if (codes.includes("usage_shop_daily_limit")) return "usage_shop_limit";
    if (codes.includes("usage_check_failed")) return "usage_check_failed";
    switch (c.aiStatus) {
      case "cannot_answer":
        return "cannot_answer";
      case "reservation":
        return "reservation_change";
      case "unsupported":
        return "unsupported";
      case "bot_off":
        return "bot_off";
      case "error":
        return "ai_error";
    }
    if (codes.some((x) => x.startsWith("reply_"))) return "reply_failed";
  }
  const e = source.event;
  if (e?.status === "abandoned" || e?.lastError?.startsWith("stalled")) return "stalled";
  if (e?.lastError?.startsWith("reply_")) return "reply_failed";
  return "system_error";
}

/**
 * URL・ドメイン名らしい部分。お客様が書いた URL がオーナーの LINE でリンクになり、
 * 通知の一部と誤認して開かれる（フィッシング）のを防ぐため、通知文では伏せる
 */
const URL_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/:?#]\S*)?/gi;

/** 質問の先頭部分。電話番号・メール・ユーザー ID・URL を伏せ、改行・空白をまとめて短くする */
export function excerptOf(text: string | null): string | null {
  if (!text) return null;
  const flat = maskPersonalInfo(text).replace(URL_LIKE, "[URL省略]").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  return chars.length > EXCERPT_CHARS ? `${chars.slice(0, EXCERPT_CHARS).join("")}…` : flat;
}

const TEXT_CATEGORIES = new Set<NotificationCategory>([
  "cannot_answer",
  "reservation_change",
  "bot_off",
  "ai_error",
  "usage_shop_limit",
  "usage_check_failed",
  "reply_failed",
]);

export function toItem(source: NotificationSource): NotificationItem {
  const category = classify(source);
  return {
    eventId: source.eventId,
    receivedAt: source.receivedAt,
    category,
    excerpt: TEXT_CATEGORIES.has(category) ? excerptOf(source.conversation?.userMessage ?? null) : null,
  };
}

const JST = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatJst(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "日時不明";
  const parts = Object.fromEntries(JST.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

/** 未対応一覧の URL。APP_BASE_URL が https（ローカル確認用の http://localhost を含む）でなければ載せない */
export function inboxUrl(appBaseUrl: string | null): string | null {
  if (!appBaseUrl) return null;
  let base: URL;
  try {
    base = new URL(appBaseUrl);
  } catch {
    return null;
  }
  const local = base.protocol === "http:" && (base.hostname === "localhost" || base.hostname === "127.0.0.1");
  if (base.protocol !== "https:" && !local) return null;
  if (base.username || base.password) return null;
  return new URL("/admin/inbox", base.origin).toString();
}

export type RenderInput = {
  /** 詳細を表示するもの（新しい順・最大 MAX_LISTED_ITEMS 件） */
  items: NotificationItem[];
  /** まとめの対象の総数（items より多ければ「ほか N 件」） */
  total: number;
  /** 店舗全体の AI 利用上限に達した通知 */
  urgent: boolean;
  appBaseUrl: string | null;
};

export function renderOwnerNotification(input: RenderInput): string {
  const items = input.items.slice(0, MAX_LISTED_ITEMS);
  const total = Math.max(input.total, items.length);
  const lines: string[] = [];

  if (input.urgent || items.some((i) => i.category === "usage_shop_limit")) {
    lines.push("【重要】本日の AI 自動応答の利用上限に達しました。以降のお問い合わせには定型文で返信しています。");
  }
  lines.push(`【要対応】LINE のお問い合わせ ${total} 件`);
  for (const item of items) {
    const excerpt = item.excerpt ? `「${item.excerpt}」` : "";
    lines.push(`・${formatJst(item.receivedAt)} ${LABELS[item.category]}${excerpt}`);
  }
  const rest = total - items.length;
  if (rest > 0) lines.push(`ほか ${rest} 件`);

  const url = inboxUrl(input.appBaseUrl);
  // お客様への返信方法（LINE 公式アカウントのチャットとの併用）は要確認のため、通知には書かない（設計書 6.3）
  lines.push(url ? `未対応一覧：${url}` : "管理画面の未対応一覧でご確認ください。");

  const text = lines.join("\n");
  return Array.from(text).length > MAX_NOTIFICATION_CHARS ? Array.from(text).slice(0, MAX_NOTIFICATION_CHARS).join("") : text;
}
