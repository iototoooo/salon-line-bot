import { describe, expectTypeOf, it } from "vitest";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import type { Database as GeneratedDatabase } from "@/types/database.generated";
import type {
  AiStatus,
  ConversationInsert,
  Database,
  FaqCategory,
  FaqRow,
  LineWebhookEventRow,
  MenuCategory,
  ReplyStatus,
  WebhookEventStatus,
} from "@/types/database";

/**
 * 型の絞り込みが効いているかを確認する（npm run typecheck で検査される。実行時は何もしない）。
 * どこかが any に崩れると expectTypeOf と @ts-expect-error が型エラーになる。
 */
declare const db: ServerSupabaseClient; // 型だけの宣言（実行時は存在しない）

describe("Database 型（生成型 + CHECK 制約の絞り込み）", () => {
  it("CHECK 制約のある列は文字列リテラルに絞られる", () => {
    expectTypeOf<FaqRow["category"]>().toEqualTypeOf<FaqCategory>();
    expectTypeOf<Database["public"]["Tables"]["menus"]["Row"]["category"]>().toEqualTypeOf<MenuCategory>();
    expectTypeOf<LineWebhookEventRow["status"]>().toEqualTypeOf<WebhookEventStatus>();
    expectTypeOf<LineWebhookEventRow["reply_status"]>().toEqualTypeOf<ReplyStatus>();
    expectTypeOf<ConversationInsert["ai_status"]>().toEqualTypeOf<AiStatus>();
  });

  it("絞り込まない列・nullable は生成型のまま", () => {
    type GenFaq = GeneratedDatabase["public"]["Tables"]["faqs"]["Row"];
    expectTypeOf<FaqRow["question"]>().toEqualTypeOf<GenFaq["question"]>();
    expectTypeOf<FaqRow["updated_at"]>().toEqualTypeOf<string>();
    expectTypeOf<Database["public"]["Tables"]["menus"]["Row"]["duration_min"]>().toEqualTypeOf<number | null>();
    expectTypeOf<keyof FaqRow>().toEqualTypeOf<keyof GenFaq>();
  });

  it("Insert の必須・任意は生成型に従う", () => {
    expectTypeOf<Pick<ConversationInsert, "ai_status">>().toEqualTypeOf<{ ai_status: AiStatus }>();
    expectTypeOf<ConversationInsert>().not.toHaveProperty("id");
    // ai_category は任意（null 可）
    const ok: ConversationInsert = { line_event_id: "e", line_user_id: "U", message_type: "text", ai_status: "answered" };
    void ok;
    // @ts-expect-error CHECK 制約にない値は代入できない
    const ng: ConversationInsert = { line_event_id: "e", line_user_id: "U", message_type: "text", ai_status: "unknown" };
    void ng;
  });

  it("supabase-js の select 結果にも絞り込みが反映される", () => {
    // 型検査専用（呼び出さない）
    const typeOnly = async () => {
      const { data } = await db.from("faqs").select("*").eq("is_published", true);
      expectTypeOf(data).toEqualTypeOf<FaqRow[] | null>();
    };
    expectTypeOf(typeOnly).toBeFunction();
  });

  it("RPC の引数：値の限定と、既定値のある引数に null を渡せないこと", () => {
    // 型検査専用（呼び出さない）
    const typeOnly = () => {
    void db.rpc("record_line_reply_result", { p_webhook_event_id: "e", p_result: "sent" });
    // @ts-expect-error 返信結果は sent / failed / unknown のみ
    void db.rpc("record_line_reply_result", { p_webhook_event_id: "e", p_result: "done" });
    // @ts-expect-error 終了状態は done / skipped / failed のみ
    void db.rpc("finish_line_webhook_event", { p_webhook_event_id: "e", p_status: "processing" });
    void db.rpc("claim_line_webhook_event", { p_webhook_event_id: "e", p_event_type: "message", p_is_redelivery: false });
    // @ts-expect-error 既定値のある引数は省略する（null は渡さない）
    void db.rpc("claim_line_webhook_event", { p_webhook_event_id: "e", p_event_type: "message", p_is_redelivery: false, p_event_timestamp: null });
    };
    expectTypeOf(typeOnly).toBeFunction();
  });
});
