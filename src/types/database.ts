/**
 * Supabase（PostgreSQL）のスキーマ型。
 *
 * 基本は実際の DB から生成した型（./database.generated.ts、`npm run gen:types` で再生成）を使い、
 * ここでは次の 2 点だけを上書きする。
 *   1. CHECK 制約で値が限られている列（category・status など）を文字列リテラルの型に絞る
 *      （PostgreSQL の CHECK 制約は生成型に反映されず string になるため）
 *   2. 既存コードが使う型の別名（FaqRow など）
 * 列の追加・削除・nullable の変更は生成型に従う。マイグレーションを変更したら必ず再生成すること。
 */
import type { Database as GeneratedDatabase } from "./database.generated";

export type { Json } from "./database.generated";

// ---------------------------------------------------------------------------
// CHECK 制約に対応する値（supabase/migrations と一致させる）
// ---------------------------------------------------------------------------
export type FaqCategory = "hours" | "price" | "reservation" | "treatment" | "access" | "other";
export type MenuCategory = "cut" | "color" | "perm" | "treatment" | "set" | "other";
export type AiStatus = "answered" | "cannot_answer" | "reservation" | "bot_off" | "error" | "unsupported";
export type ReplyMethod = "reply" | "push" | "none";
export type BroadcastStatus = "draft" | "tested" | "sending" | "sent" | "failed";
export type WebhookEventStatus = "processing" | "done" | "skipped" | "failed" | "abandoned";
export type ReplyStatus = "none" | "sending" | "sent" | "simulated" | "failed" | "unknown";
/** sent: LINE が受理（2xx） / simulated: dry-run のため未送信 / failed: LINE が拒否 / unknown: 成否不明 */
export type ReplyResult = "sent" | "simulated" | "failed" | "unknown";
export type WebhookEventFinalStatus = "done" | "skipped" | "failed";
/** AI 回答の根拠にできる shop_settings の項目（conversations.source_shop_fields の許可リスト） */
export type ShopKnowledgeField =
  | "shop_name"
  | "business_hours"
  | "regular_holidays"
  | "address"
  | "phone"
  | "parking"
  | "reservation_guide"
  | "temporary_notice";

// ---------------------------------------------------------------------------
// 生成型の一部の列を絞り込むための型ユーティリティ
// ---------------------------------------------------------------------------
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];

/** T の K 列を R[K] に置き換える（必須・任意の区別は T に従う） */
type Override<T, R> = Simplify<
  Omit<T, keyof R> & { [K in keyof R as K extends RequiredKeys<T> ? K : never]: R[K] } & {
    [K in keyof R as K extends RequiredKeys<T> ? never : K]?: R[K];
  }
>;

type GenTables = GeneratedDatabase["public"]["Tables"];
type GenFunctions = GeneratedDatabase["public"]["Functions"];

/** テーブルの Row / Insert / Update の該当列をまとめて絞り込む */
type NarrowTable<T extends GenTables[keyof GenTables], R> = {
  Row: Override<T["Row"], R>;
  Insert: Override<T["Insert"], R>;
  Update: Override<T["Update"], R>;
  Relationships: T["Relationships"];
};

type Narrowed = {
  admin_users: GenTables["admin_users"];
  shop_settings: GenTables["shop_settings"];
  faqs: NarrowTable<GenTables["faqs"], { category: FaqCategory }>;
  menus: NarrowTable<GenTables["menus"], { category: MenuCategory }>;
  conversations: NarrowTable<
    GenTables["conversations"],
    {
      ai_status: AiStatus;
      ai_category: FaqCategory | null;
      reply_method: ReplyMethod;
      // 5 本目のマイグレーションの CHECK 制約（許可リスト）に対応
      source_shop_fields: ShopKnowledgeField[];
    }
  >;
  broadcasts: NarrowTable<GenTables["broadcasts"], { status: BroadcastStatus }>;
  line_webhook_events: NarrowTable<
    GenTables["line_webhook_events"],
    { status: WebhookEventStatus; reply_status: ReplyStatus }
  >;
  ai_usage_reservations: GenTables["ai_usage_reservations"];
  owner_notification_batches: GenTables["owner_notification_batches"];
};

type NarrowedFunctions = Omit<
  GenFunctions,
  "record_line_reply_result" | "finish_line_webhook_event" | "mark_stalled_line_webhook_events"
> & {
  // reserve_ai_usage は生成型のまま使う（戻り値 text は src/lib/db/ai-usage.ts で許可リストと照合する）
  // claim_owner_notification_batch・finish_owner_notification_batch も生成型のまま使う
  // （戻り値の jsonb は src/lib/db/owner-notifications.ts で形を検証する）
  // run_retention_purge も生成型のまま使う（戻り値の jsonb は src/lib/db/retention.ts で形を検証する）
  record_line_reply_result: {
    Args: Override<GenFunctions["record_line_reply_result"]["Args"], { p_result: ReplyResult }>;
    Returns: GenFunctions["record_line_reply_result"]["Returns"];
  };
  finish_line_webhook_event: {
    Args: Override<GenFunctions["finish_line_webhook_event"]["Args"], { p_status: WebhookEventFinalStatus }>;
    Returns: GenFunctions["finish_line_webhook_event"]["Returns"];
  };
  mark_stalled_line_webhook_events: {
    Args: GenFunctions["mark_stalled_line_webhook_events"]["Args"];
    Returns: Override<GenFunctions["mark_stalled_line_webhook_events"]["Returns"][number], { reply_status: ReplyStatus }>[];
  };
};

/** supabase-js に渡す Database 型（生成型 + 値の絞り込み） */
export type Database = Omit<GeneratedDatabase, "public"> & {
  public: Omit<GeneratedDatabase["public"], "Tables" | "Functions"> & {
    Tables: Narrowed;
    Functions: NarrowedFunctions;
  };
};

// ---------------------------------------------------------------------------
// 既存コードで使う別名
// ---------------------------------------------------------------------------
type PublicTables = Database["public"]["Tables"];

export type AdminUserRow = PublicTables["admin_users"]["Row"];
export type ShopSettingsRow = PublicTables["shop_settings"]["Row"];
export type FaqRow = PublicTables["faqs"]["Row"];
export type MenuRow = PublicTables["menus"]["Row"];
export type ConversationRow = PublicTables["conversations"]["Row"];
/** 会話ログの保存。id は DB が採番するため受け付けない */
export type ConversationInsert = Omit<PublicTables["conversations"]["Insert"], "id">;
export type BroadcastRow = PublicTables["broadcasts"]["Row"];
export type LineWebhookEventRow = PublicTables["line_webhook_events"]["Row"];
