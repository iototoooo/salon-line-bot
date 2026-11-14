import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractPhoneNumbers, extractUrls, extractYenAmounts, hasAmbiguousAmount, hasAvailabilityClaim } from "@/lib/ai/guard";
import { createMigratedDb } from "./pglite";

/**
 * 学習用の架空の美容室の初期データ（scripts/supabase/sample-data/sample-salon.sql）を PGlite に適用して確認する。
 * 実際の Supabase には接続しない。
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const FILE = join(process.cwd(), "scripts", "supabase", "sample-data", "sample-salon.sql");
const SQL = readFileSync(FILE, "utf8");
const OWNER = `U${"e".repeat(32)}`;

let db: PGlite;
beforeEach(async () => {
  db = await createMigratedDb();
});

type Shop = Record<string, unknown> & { bot_enabled: boolean; owner_line_user_id: string | null; fallback_message: string };

async function load() {
  const shop = (await db.query<Shop>("select * from public.shop_settings where id = 1")).rows[0];
  const faqs = (await db.query<{ question: string; answer: string; category: string }>("select question, answer, category from public.faqs order by sort_order")).rows;
  const menus = (await db.query<{ name: string; price: number; price_note: string; description: string }>("select * from public.menus order by sort_order")).rows;
  return { shop, faqs, menus };
}

describe("学習用サンプルデータ（sample-salon.sql）", () => {
  it("マイグレーション済みの空の DB に登録でき、FAQ 12 件・メニュー 10 件・店舗情報が入る", async () => {
    const before = (await db.query<Shop>("select * from public.shop_settings")).rows[0];
    await db.exec(SQL);
    const { shop, faqs, menus } = await load();
    expect(faqs).toHaveLength(12);
    expect(menus).toHaveLength(10);
    expect(shop.shop_name).toContain("架空");
    expect(shop.address).toContain("架空");
    // 自動応答・通知先・定型文は変更しない
    expect(shop.bot_enabled).toBe(false);
    expect(shop.owner_line_user_id).toBe(before.owner_line_user_id);
    expect(shop.fallback_message).toBe(before.fallback_message);
  });

  it("通知先が登録済みでも上書きしない", async () => {
    await db.query("update public.shop_settings set owner_line_user_id = $1", [OWNER]);
    await db.exec(SQL);
    expect((await load()).shop.owner_line_user_id).toBe(OWNER);
  });

  it("2 回目の実行は中止され、二重に登録されない", async () => {
    await db.exec(SQL);
    await expect(db.exec(SQL)).rejects.toThrow(/すでに登録/);
    await db.exec("rollback");
    const { faqs, menus } = await load();
    expect([faqs.length, menus.length]).toEqual([12, 10]);
  });

  it("自動応答が ON なら何も登録せずに中止する", async () => {
    await db.query("update public.shop_settings set bot_enabled = true");
    await expect(db.exec(SQL)).rejects.toThrow(/自動応答が ON/);
    await db.exec("rollback");
    const { shop, faqs, menus } = await load();
    expect([faqs.length, menus.length]).toEqual([0, 0]);
    expect(shop.shop_name).toBe("");
  });

  it("自動応答を ON にする・通知先を変える文を含まない", () => {
    const code = SQL.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/bot_enabled\s*=/);
    expect(code).not.toMatch(/owner_line_user_id\s*=/);
    expect(code).not.toMatch(/\b(delete|truncate|drop|grant|revoke)\b/i);
  });

  it("AI の出力検査と矛盾しない：空き状況・予約可否の断定、読み取れない金額、登録外の電話番号・URL を含まない", async () => {
    await db.exec(SQL);
    const { shop, faqs, menus } = await load();
    const shopTexts = ["shop_name", "business_hours", "regular_holidays", "address", "phone", "parking", "reservation_guide", "temporary_notice"].map(
      (k) => String(shop[k] ?? ""),
    );
    const texts = [...shopTexts, ...faqs.flatMap((f) => [f.question, f.answer]), ...menus.flatMap((m) => [m.name, m.price_note, m.description])];
    for (const t of texts) {
      // AI がそのまま引用しても、検査で「確認が必要です」に差し替えられない内容にする
      expect(hasAvailabilityClaim(t), t).toBe(false);
      expect(hasAmbiguousAmount(t), t).toBe(false);
      expect(extractUrls(t), t).toEqual([]);
    }
    // 電話番号は店舗情報の架空の番号だけ（国内で使われない 000- の形式）
    expect(new Set(texts.flatMap(extractPhoneNumbers))).toEqual(new Set(["00000000000"]));
    expect(shop.phone).toBe("000-0000-0000");
  });

  it("FAQ に書いた金額は、メニューの追加料金の記載と一致する（古い金額を残さない）", async () => {
    await db.exec(SQL);
    const { faqs, menus } = await load();
    const menuQuoted = new Set(menus.flatMap((m) => [m.price, ...extractYenAmounts(`${m.price_note} ${m.description}`)]));
    for (const f of faqs) for (const a of extractYenAmounts(f.answer)) expect(menuQuoted.has(a), `${f.question}: ${a}`).toBe(true);
  });

  it("FAQ・メニューの分類はすべて DB の制約で許可された値", async () => {
    await db.exec(SQL);
    const cats = (await db.query<{ c: string }>("select distinct category as c from public.faqs order by 1")).rows.map((r) => r.c);
    expect(cats).toEqual(["access", "hours", "other", "price", "reservation", "treatment"]);
  });

  it("db push の対象（supabase/migrations）や seed.sql には置かない（承認なしに本番へ入らない）", () => {
    expect(FILE.includes(join("supabase", "migrations"))).toBe(false);
    expect(existsSync(join(process.cwd(), "supabase", "seed.sql"))).toBe(false);
  });
});

describe("サンプルデータの取り消し（sample-salon.rollback.sql）", () => {
  const ROLLBACK = readFileSync(join(process.cwd(), "scripts", "supabase", "sample-data", "sample-salon.rollback.sql"), "utf8");
  const state = async () => {
    const s = (await db.query<Record<string, unknown>>("select * from public.shop_settings where id = 1")).rows[0];
    // 更新日時は比べない（取り消しでも更新されるため）
    const rest = { ...s };
    delete rest.updated_at;
    return {
      shop: rest,
      faqs: Number((await db.query<{ n: number }>("select count(*)::int as n from public.faqs")).rows[0].n),
      menus: Number((await db.query<{ n: number }>("select count(*)::int as n from public.menus")).rows[0].n),
    };
  };

  it("登録 → 取り消しで、登録前の状態（店舗情報は空・FAQ とメニューは 0 件）に戻る。通知先・自動応答・会話は変えない", async () => {
    await db.query("update public.shop_settings set owner_line_user_id = $1", [OWNER]);
    await db.query(
      `insert into public.conversations (line_event_id, line_user_id, message_type, ai_status) values ('01RB', $1, 'text', 'bot_off')`,
      [OWNER],
    );
    const before = await state();
    await db.exec(SQL);
    expect((await state()).faqs).toBe(12);
    await db.exec(ROLLBACK);
    expect(await state()).toEqual(before);
    expect(Number((await db.query<{ n: number }>("select count(*)::int as n from public.conversations")).rows[0].n)).toBe(1);
  });

  it("サンプル以外の FAQ・メニューは消さない（件数が合わなければ何もせずに止まる）", async () => {
    await db.exec(SQL);
    await db.query("delete from public.faqs where question = '駐車場はありますか'");
    await expect(db.exec(ROLLBACK)).rejects.toThrow(/件数が合いません/);
    await db.exec("rollback");
    expect((await state()).menus).toBe(10);
  });

  it("自動応答が ON なら何もせずに止まる", async () => {
    await db.exec(SQL);
    await db.query("update public.shop_settings set bot_enabled = true");
    await expect(db.exec(ROLLBACK)).rejects.toThrow(/自動応答が ON/);
    await db.exec("rollback");
    expect((await state()).faqs).toBe(12);
  });

  it("自動応答を ON にする・通知先を変える文を含まない", () => {
    const code = ROLLBACK.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/bot_enabled\s*=/);
    expect(code).not.toMatch(/owner_line_user_id/);
    expect(code).not.toMatch(/fallback_message/);
    expect(code).not.toMatch(/\b(truncate|drop|grant|revoke)\b/i);
  });
});

describe("登録情報の指紋（content-fingerprint.sql）", () => {
  const FP = readFileSync(join(process.cwd(), "scripts", "supabase", "content-fingerprint.sql"), "utf8");
  const fp = async () => {
    await db.exec("begin read only");
    try {
      return (await db.query<{ item: string; n: string; fingerprint: string }>(FP)).rows;
    } finally {
      await db.exec("rollback");
    }
  };

  it("読み取り専用で 3 行を返す。編集すると変わり、元の値に戻すと同じになる（更新日時は含めない）", async () => {
    await db.exec(SQL);
    const before = await fp();
    expect(before.map((r) => [r.item, r.n])).toEqual([["店舗情報（8 項目）", "1"], ["FAQ", "12"], ["メニュー", "10"]]);

    // AC-22 の想定：料金の改定と臨時のお知らせ → 元に戻す
    await db.query("update public.menus set price = 1210 where name = '前髪カット'");
    await db.query("update public.shop_settings set temporary_notice = '【テスト】臨時休業のお知らせ'");
    const changed = await fp();
    expect(changed[0].fingerprint).not.toBe(before[0].fingerprint);
    expect(changed[2].fingerprint).not.toBe(before[2].fingerprint);
    await db.query("update public.menus set price = 1100 where name = '前髪カット'");
    await db.query("update public.shop_settings set temporary_notice = ''");
    expect(await fp()).toEqual(before);

    // FAQ を追加して削除しても元どおり（作り直した行の ID・日時は指紋に含めない）
    await db.query("insert into public.faqs (question, answer, is_published) values ('【AC-22 テスト】', '【テスト】', false)");
    expect((await fp())[1].n).toBe("13");
    await db.query("delete from public.faqs where question = '【AC-22 テスト】'");
    expect(await fp()).toEqual(before);
  });

  it("本文・ID を表示しない（指紋と件数だけ）", async () => {
    await db.exec(SQL);
    const text = JSON.stringify(await fp());
    expect(text).not.toContain("こもれび");
    expect(text).not.toContain("カット");
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
