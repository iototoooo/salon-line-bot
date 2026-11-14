import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { asServiceRole, createDbWithMigrations, createMigratedDb, migrationFiles } from "./pglite";

/**
 * 5 本目のマイグレーション（conversations の根拠列）を PGlite で検証する。
 * 実際の Supabase には接続しない。
 */
// PGlite の DB を複数作るテストがあり、並列実行時に既定の 5 秒を超えることがあるため延ばす
vi.setConfig({ testTimeout: 30_000 });

const FIFTH = "20261112000000_conversation_ai_sources.sql";
const ROLLBACK = join(process.cwd(), "scripts", "supabase", "rollback", "20261112000000_conversation_ai_sources.down.sql");
const LINE_USER = `U${"b".repeat(32)}`;
const ADMIN = "11111111-1111-1111-1111-111111111111";
const NON_ADMIN = "22222222-2222-2222-2222-222222222222";
const FAQ_ID = "b0000000-0000-4000-8000-000000000001";
const MENU_ID = "a0000000-0000-4000-8000-000000000001";
const NEW_COLUMNS = ["source_faq_ids", "source_menu_ids", "source_shop_fields", "ai_reason"];
const DENIED = /permission denied/;

/** 1〜4 本目（5 本目の適用前） */
const withoutFifth = () => migrationFiles().filter((f) => f < FIFTH);
/** 1〜5 本目（6 本目以降を含めない） */
const upToFifth = () => migrationFiles().filter((f) => f <= FIFTH);
const fifthSql = () => readFileSync(join(process.cwd(), "supabase", "migrations", FIFTH), "utf8");

async function as(db: PGlite, role: "anon" | "authenticated" | "service_role", sql: string, sub = "") {
  await db.exec(`set request.jwt.claim.sub = '${sub}'`);
  await db.exec(`set role ${role}`);
  try {
    return await db.query<Record<string, unknown>>(sql);
  } finally {
    await db.exec("reset role; reset request.jwt.claim.sub");
  }
}

let seq = 0;
function insert(db: PGlite, columns: Record<string, string> = {}) {
  seq++;
  const cols = ["line_event_id", "line_user_id", "message_type", "ai_status", ...Object.keys(columns)];
  const vals = [`'ev-src-${seq}'`, `'${LINE_USER}'`, "'text'", "'answered'", ...Object.values(columns)];
  return asServiceRole(db, `insert into public.conversations (${cols.join(", ")}) values (${vals.join(", ")}) returning *`);
}

/** conversations 以外も含めた、権限・ポリシー・関数・制約・列の一覧（適用前後の比較用） */
async function catalogSnapshot(db: PGlite) {
  const q = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows;
  return {
    functions: await q(`select n.nspname, p.proname, md5(p.prosrc) as src, p.prosecdef, coalesce(p.proacl::text, '') as acl
                         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname in ('public', 'private') order by 1, 2, 3`),
    policies: await q("select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies order by 1, 2"),
    tableGrants: await q(`select table_name, grantee, privilege_type from information_schema.role_table_grants
                           where table_schema = 'public' order by 1, 2, 3`),
    columnGrants: await q(`select table_name, column_name, grantee, privilege_type from information_schema.column_privileges
                            where table_schema = 'public' and grantee in ('anon', 'authenticated')
                              and not (table_name = 'conversations' and column_name = any(array['${NEW_COLUMNS.join("','")}']))
                            order by 1, 2, 3, 4`),
    constraints: await q(`select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def from pg_constraint
                           where connamespace = 'public'::regnamespace and conname not like 'conversations_source_%'
                             and conname <> 'conversations_ai_reason_check' order by 1, 2`),
    columns: await q(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
                       where table_schema = 'public'
                         and not (table_name = 'conversations' and column_name = any(array['${NEW_COLUMNS.join("','")}']))
                       order by 1, 2`),
    rls: await q("select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1"),
    triggers: await q("select tgrelid::regclass::text as tbl, tgname from pg_trigger where not tgisinternal order by 1, 2"),
    indexes: await q("select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2"),
  };
}

describe("既存の 4 本との整合性・ほかへの影響", () => {
  it("5 本目は 4 本目の直後（5 番目）に適用される", () => {
    expect(migrationFiles()[4]).toBe(FIFTH);
    expect(withoutFifth()).toHaveLength(4);
  });

  it("適用前後で、追加の 4 列と 4 つの制約以外（関数・ポリシー・権限・RLS・トリガー・インデックス・他の列）は変わらない", async () => {
    const before = await createDbWithMigrations(withoutFifth());
    const after = await createDbWithMigrations(upToFifth());
    expect(await catalogSnapshot(after)).toEqual(await catalogSnapshot(before));
  });

  it("既存の会話ログは、追加列が既定値（空配列・null）になるだけで、ほかの列は変わらない", async () => {
    const db = await createDbWithMigrations(withoutFifth());
    await insert(db, { user_message: "'営業時間は？'", bot_reply: "'10時からです'", needs_owner: "true" });
    const before = (await db.query("select * from public.conversations")).rows[0] as Record<string, unknown>;
    await db.exec(fifthSql());
    const after = (await db.query("select * from public.conversations")).rows[0] as Record<string, unknown>;
    expect(after).toEqual({ ...before, source_faq_ids: [], source_menu_ids: [], source_shop_fields: [], ai_reason: null });
  });

  it("取り消し用 SQL（手動用）で 5 本目の適用前と同じ状態に戻せる", async () => {
    const before = await createDbWithMigrations(withoutFifth());
    const db = await createDbWithMigrations(upToFifth());
    await insert(db, { ai_reason: "'理由'" });
    await db.exec(readFileSync(ROLLBACK, "utf8"));
    const cols = await db.query("select column_name from information_schema.columns where table_name = 'conversations' and column_name = any($1)", [NEW_COLUMNS]);
    expect(cols.rows).toEqual([]);
    expect(await catalogSnapshot(db)).toEqual(await catalogSnapshot(before));
    // 会話ログの行そのものは残る
    expect((await db.query("select count(*)::int as n from public.conversations")).rows).toEqual([{ n: 1 }]);
  });
});

describe("適用前チェック（precheck-conversation-sources.sql・読み取り専用）", () => {
  const PRECHECK = join(process.cwd(), "scripts", "supabase", "precheck-conversation-sources.sql");
  /** Supabase の適用履歴テーブルを模す */
  async function withHistory(db: PGlite, files: string[]) {
    await db.exec("create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key)");
    for (const f of files) await db.query("insert into supabase_migrations.schema_migrations values ($1)", [f.slice(0, 14)]);
    return db;
  }
  const run = async (db: PGlite) =>
    (await db.query<{ result: string; item: string }>(readFileSync(PRECHECK, "utf8"))).rows;

  it("4 本適用済み・5 本目未適用の状態なら全項目 OK", async () => {
    const rows = await run(await withHistory(await createDbWithMigrations(withoutFifth()), withoutFifth()));
    expect(rows.length).toBeGreaterThanOrEqual(14);
    expect(rows.filter((r) => r.result !== "OK")).toEqual([]);
  });

  it("5 本目が適用済みなら NG（二重適用を防ぐ）", async () => {
    const ng = (await run(await withHistory(await createMigratedDb(), migrationFiles())))
      .filter((r) => r.result === "NG")
      .map((r) => r.item);
    expect(ng).toEqual(
      expect.arrayContaining(["適用履歴が 4 本（1〜4 本目）で、5 本目は未適用", "追加する 4 列がまだ存在しない"]),
    );
  });

  it("自動応答が ON になっていたら NG", async () => {
    const db = await withHistory(await createDbWithMigrations(withoutFifth()), withoutFifth());
    await db.exec("update public.shop_settings set bot_enabled = true");
    expect((await run(db)).filter((r) => r.result === "NG").map((r) => r.item)).toEqual(["shop_settings：1 行・自動応答は OFF"]);
  });
});

describe("conversations の根拠列（5 本目）", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createMigratedDb();
    await db.exec(`
      insert into auth.users (id) values ('${ADMIN}'), ('${NON_ADMIN}');
      insert into public.admin_users (user_id, display_name) values ('${ADMIN}', 'owner');
    `);
  });

  it("列の型・NULL 可否・既定値", async () => {
    const r = await db.query(
      `select column_name, udt_name, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'conversations' and column_name = any($1) order by column_name`,
      [NEW_COLUMNS],
    );
    expect(r.rows).toEqual([
      { column_name: "ai_reason", udt_name: "text", is_nullable: "YES", column_default: null },
      { column_name: "source_faq_ids", udt_name: "_uuid", is_nullable: "NO", column_default: "'{}'::uuid[]" },
      { column_name: "source_menu_ids", udt_name: "_uuid", is_nullable: "NO", column_default: "'{}'::uuid[]" },
      { column_name: "source_shop_fields", udt_name: "_text", is_nullable: "NO", column_default: "'{}'::text[]" },
    ]);
  });

  it("service_role が根拠の ID・店舗項目・理由を保存できる", async () => {
    const r = await insert(db, {
      source_faq_ids: `array['${FAQ_ID}']::uuid[]`,
      source_menu_ids: `array['${MENU_ID}']::uuid[]`,
      source_shop_fields: "array['business_hours','parking']",
      ai_reason: "'登録情報に記載なし'",
    });
    expect(r.rows[0]).toMatchObject({
      source_faq_ids: [FAQ_ID],
      source_menu_ids: [MENU_ID],
      source_shop_fields: ["business_hours", "parking"],
      ai_reason: "登録情報に記載なし",
    });
  });

  it("上限ちょうど（ID 20 件・店舗項目 8 種・理由 300 文字）は保存できる", async () => {
    await expect(
      insert(db, {
        source_faq_ids: `array_fill('${FAQ_ID}'::uuid, array[20])`,
        source_menu_ids: `array_fill('${MENU_ID}'::uuid, array[20])`,
        source_shop_fields:
          "array['shop_name','business_hours','regular_holidays','address','phone','parking','reservation_guide','temporary_notice']",
        ai_reason: "repeat('あ', 300)",
      }),
    ).resolves.toBeDefined();
  });

  it("列を指定しない保存（既存の保存処理）は既定値になる", async () => {
    const r = await insert(db);
    expect(r.rows[0]).toMatchObject({ source_faq_ids: [], source_menu_ids: [], source_shop_fields: [], ai_reason: null });
  });

  it.each([
    ["許可されていない店舗項目", { source_shop_fields: "array['owner_line_user_id']" }, /check constraint/],
    ["店舗項目の 11 件以上", { source_shop_fields: "array_fill('phone'::text, array[11])" }, /check constraint/],
    ["21 件以上の FAQ ID", { source_faq_ids: `array_fill('${FAQ_ID}'::uuid, array[21])` }, /check constraint/],
    ["21 件以上のメニュー ID", { source_menu_ids: `array_fill('${MENU_ID}'::uuid, array[21])` }, /check constraint/],
    ["FAQ ID に null 要素", { source_faq_ids: "array[null]::uuid[]" }, /check constraint/],
    ["メニュー ID に null 要素", { source_menu_ids: `array['${MENU_ID}', null]::uuid[]` }, /check constraint/],
    ["店舗項目に null 要素", { source_shop_fields: "array[null]::text[]" }, /check constraint/],
    ["UUID でない ID", { source_faq_ids: "array['F1']::uuid[]" }, /invalid input syntax/],
    ["配列に null", { source_faq_ids: "null" }, /not-null/],
    ["301 文字以上の理由", { ai_reason: "repeat('あ', 301)" }, /check constraint/],
  ])("%s は拒否", async (_label, cols, error) => {
    await expect(insert(db, cols)).rejects.toThrow(error);
  });

  it("anon は会話ログ（新しい列を含む）を参照できない", async () => {
    await expect(as(db, "anon", "select source_faq_ids from public.conversations")).rejects.toThrow(DENIED);
  });

  it("管理者は新しい列を参照でき、管理者でないユーザーには 1 行も見えない（管理画面からの参照）", async () => {
    const admin = await as(db, "authenticated", "select source_menu_ids, source_shop_fields, ai_reason from public.conversations", ADMIN);
    expect(admin.rows.length).toBeGreaterThan(0);
    const other = await as(db, "authenticated", "select source_menu_ids from public.conversations", NON_ADMIN);
    expect(other.rows).toEqual([]);
  });

  it.each(NEW_COLUMNS)("管理者でも %s は更新できない（ログの改ざん防止）", async (col) => {
    const value = col === "ai_reason" ? "'x'" : "'{}'";
    await expect(as(db, "authenticated", `update public.conversations set ${col} = ${value}`, ADMIN)).rejects.toThrow(DENIED);
  });

  it("管理者の「対応済み」の更新は従来どおりできる", async () => {
    await as(db, "authenticated", `update public.conversations set resolved_at = now(), resolved_by = '${ADMIN}'`, ADMIN);
    const r = await db.query("select count(*)::int as n from public.conversations where resolved_at is null");
    expect(r.rows).toEqual([{ n: 0 }]);
  });

  it("保持期間の削除（purge_expired_data）は新しい列があっても動く", async () => {
    await insert(db, { created_at: "now() - interval '91 days'", ai_reason: "'古いログ'" });
    const r = await asServiceRole<{ deleted_conversations: number }>(db, "select * from private.purge_expired_data()");
    expect(Number(r.rows[0].deleted_conversations)).toBe(1);
    const left = await db.query("select count(*)::int as n from public.conversations where ai_reason = '古いログ'");
    expect(left.rows).toEqual([{ n: 0 }]);
  });
});
