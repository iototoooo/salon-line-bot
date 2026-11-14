import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateAnswer } from "@/lib/ai/answer";
import { buildKnowledge, type Knowledge } from "@/lib/ai/knowledge";
import type { FaqRow, MenuRow, ShopSettingsRow } from "@/types/database";
import { draft, fakeModel } from "../ai/fixtures";
import { createMigratedDb } from "./pglite";

/**
 * 本番に登録した学習用サンプルデータ（sample-salon.sql）で、回答の事前判定と出力の確認が想定どおりに動くことを確かめる。
 * PGlite（ローカル）にサンプルを入れ、AI はモック（fakeModel）。実際の Claude API・本番 DB には接続しない。
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SQL = readFileSync(join(process.cwd(), "scripts", "supabase", "sample-data", "sample-salon.sql"), "utf8");
const ERROR_MESSAGE = "お問い合わせありがとうございます。担当者が確認して、改めてご連絡いたします。";

let db: PGlite;
beforeEach(async () => {
  db = await createMigratedDb();
});

/** 本番の Webhook・回答テストと同じく、店舗情報と「公開中」の FAQ・メニューから登録情報を作る */
async function loadKnowledge(): Promise<Knowledge> {
  const shop = (await db.query<ShopSettingsRow>("select * from public.shop_settings where id = 1")).rows[0];
  const faqs = (await db.query<FaqRow>("select * from public.faqs where is_published order by sort_order, created_at")).rows;
  const menus = (await db.query<MenuRow>("select * from public.menus where is_published order by sort_order, created_at")).rows;
  return buildKnowledge(shop, faqs, menus);
}

const ask = (knowledge: Knowledge, question: string, model: ReturnType<typeof fakeModel>["model"] | null = null) => {
  const reserveUsage = vi.fn(async () => "reserved" as const);
  return { reserveUsage, result: generateAnswer({ question, knowledge, model, errorMessage: ERROR_MESSAGE, reserveUsage, now: () => 0 }) };
};
const menuRef = (k: Knowledge, name: string) => k.menus.find((m) => m.name === name)!.ref;

describe("サンプルデータでの回答の事前判定（AI はモック）", () => {
  it("登録前は「登録情報なし」で止まり、登録後は AI を呼ぶ前の判定を通過する（AI 未設定なら呼ばない）", async () => {
    const empty = ask(await loadKnowledge(), "カットはいくらですか？");
    expect(await empty.result).toMatchObject({ status: "cannot_answer", code: "no_knowledge" });

    await db.exec(SQL);
    const k = await loadKnowledge();
    expect([k.faqs.length, k.menus.length, k.truncated]).toEqual([12, 10, false]);
    expect(k.shop.shop_name).toContain("こもれびの森");

    const after = ask(k, "カットはいくらですか？");
    expect(await after.result).toMatchObject({ status: "error", code: "ai_not_configured", replyText: ERROR_MESSAGE });
    // AI を呼ばない設定では、利用枠の確保（AI 呼び出しの直前）にも進まない
    expect(after.reserveUsage).not.toHaveBeenCalled();
  });

  it("メニューの料金どおりの回答は採用、登録外の金額は不採用（確認が必要です）", async () => {
    await db.exec(SQL);
    const k = await loadKnowledge();
    const ok = fakeModel(draft({ answer: "カットは4,400円です（シャンプー・ブロー込み）。", category: "price", menu_refs: [menuRef(k, "カット")] }));
    expect(await ask(k, "カットはいくらですか？", ok.model).result).toMatchObject({ status: "answered" });

    const ng = fakeModel(draft({ answer: "カットは4,000円です。", category: "price", menu_refs: [menuRef(k, "カット")] }));
    expect(await ask(k, "カットはいくらですか？", ng.model).result).toMatchObject({ status: "cannot_answer", needsOwner: true });

    // ロングの追加料金（メニューの補足に書いた金額）は引用として採用される
    const long = fakeModel(draft({ answer: "カラーは6,600円で、ロングは1,100円追加です。", category: "price", menu_refs: [menuRef(k, "カラー")] }));
    expect(await ask(k, "ロングのカラーはいくら？", long.model).result).toMatchObject({ status: "answered" });
  });

  it("空き状況の質問は、AI の文章を使わず店舗の予約の案内を返す（空きの断定もしない）", async () => {
    await db.exec(SQL);
    const k = await loadKnowledge();
    const m = fakeModel(draft({ answer: "明日10時は空いています。", category: "reservation", shop_refs: ["S:reservation_guide"] }));
    const r = await ask(k, "明日の10時に予約できますか？", m.model).result;
    expect(r.status).toBe("reservation");
    expect(r.replyText).toContain("この LINE のトークで「お名前・ご希望のメニュー・ご希望の日時");
    expect(r.replyText).not.toMatch(/空いています/);
  });

  it("登録外の電話番号は不採用。店舗情報の架空の番号は採用", async () => {
    await db.exec(SQL);
    const k = await loadKnowledge();
    const ng = fakeModel(draft({ answer: "お電話は 03-1234-5678 までどうぞ。", category: "other", shop_refs: ["S:phone"] }));
    expect(await ask(k, "電話番号は？", ng.model).result).toMatchObject({ status: "cannot_answer" });
    const ok = fakeModel(draft({ answer: "お電話は 000-0000-0000 です。", category: "other", shop_refs: ["S:phone"] }));
    expect(await ask(k, "電話番号は？", ok.model).result).toMatchObject({ status: "answered" });
  });
});
