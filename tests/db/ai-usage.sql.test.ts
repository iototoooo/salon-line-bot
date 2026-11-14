import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDbWithMigrations, createMigratedDb, migrationFiles } from "./pglite";

/**
 * 6 本目のマイグレーション（AI 利用回数制限：ai_usage_reservations / reserve_ai_usage）を PGlite で検証する。
 * 実際の Supabase には接続しない。
 *
 * 注意：PGlite は接続が 1 つのため、同時リクエストは実際には直列に実行される。
 * 本番（PostgreSQL）では pg_advisory_xact_lock で確認と確保を直列化しており、
 * ここでは「並列に呼び出しても上限・重複の判定が崩れないこと」と「ロックを取る実装であること」を確認する。
 */
// PGlite の DB を複数作るテストがあり、並列実行時に既定の 5 秒を超えることがあるため延ばす
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SIXTH = "20261113000000_ai_usage_limits.sql";
const USER_A = `U${"a".repeat(32)}`;
const USER_B = `U${"b".repeat(32)}`;
const DENIED = /permission denied/;

let db: PGlite;
let seq = 0;
const nextId = () => `01USAGE${String(++seq).padStart(10, "0")}`;

async function as(role: "anon" | "authenticated" | "service_role", sql: string, params: unknown[] = []) {
  await db.exec(`set role ${role}`);
  try {
    return await db.query<Record<string, unknown>>(sql, params);
  } finally {
    await db.exec("reset role");
  }
}

/** service_role として利用枠を確保する（既定の上限：10 分 5 回・1 日 30 回・店舗 300 回） */
async function reserve(user = USER_A, eventId = nextId(), limits: [number, number, number] = [5, 30, 300]) {
  const r = await as("service_role", "select public.reserve_ai_usage($1, $2, $3, $4, $5) as result", [eventId, user, ...limits]);
  return r.rows[0].result as string;
}

/** 過去の利用記録を直接用意する（postgres として。時刻をずらすため） */
async function seedUsage(user: string, count: number, reservedAt: string) {
  await db.query(
    `insert into public.ai_usage_reservations (webhook_event_id, user_key, jst_date, reserved_at)
     select 'seed-' || gen_random_uuid(), encode(sha256(convert_to($1, 'UTF8')), 'hex'),
            ((${reservedAt}) at time zone 'Asia/Tokyo')::date, ${reservedAt}
       from generate_series(1, $2)`,
    [user, count],
  );
}

const count = async () => Number((await db.query<{ n: number }>("select count(*)::int as n from public.ai_usage_reservations")).rows[0].n);

beforeEach(async () => {
  db = await createMigratedDb();
});

describe("利用枠の確保（reserve_ai_usage）", () => {
  it("上限内なら reserved を返し、1 件記録する", async () => {
    expect(await reserve()).toBe("reserved");
    expect(await count()).toBe(1);
  });

  it("同じ webhookEventId では二重に消費しない（duplicate）", async () => {
    const id = nextId();
    expect(await reserve(USER_A, id)).toBe("reserved");
    expect(await reserve(USER_A, id)).toBe("duplicate");
    expect(await count()).toBe(1);
  });

  it("同一ユーザー：10 分間に 5 回まで。6 回目は user_burst_limit で記録しない", async () => {
    for (let i = 0; i < 5; i++) expect(await reserve()).toBe("reserved");
    expect(await reserve()).toBe("user_burst_limit");
    expect(await count()).toBe(5);
    // 別のユーザーには影響しない
    expect(await reserve(USER_B)).toBe("reserved");
  });

  it("10 分より前の利用は 10 分間の上限に数えない", async () => {
    await seedUsage(USER_A, 5, "now() - interval '11 minutes'");
    expect(await reserve()).toBe("reserved");
  });

  it("同一ユーザー：日本時間の 1 日に 30 回まで", async () => {
    // 当日・10 分より前に 30 回（日付の境界をまたがないよう、確保する時刻と同じ日本時間の日付で用意する）
    await db.query(
      `insert into public.ai_usage_reservations (webhook_event_id, user_key, jst_date, reserved_at)
       select 'seed-' || i, encode(sha256(convert_to($1, 'UTF8')), 'hex'), (now() at time zone 'Asia/Tokyo')::date,
              now() - interval '11 minutes'
         from generate_series(1, 30) i`,
      [USER_A],
    );
    expect(await reserve()).toBe("user_daily_limit");
    expect(await reserve(USER_B)).toBe("reserved");
  });

  it("店舗全体：日本時間の 1 日に 300 回まで（ユーザーに関係なく）", async () => {
    await db.query(
      `insert into public.ai_usage_reservations (webhook_event_id, user_key, jst_date, reserved_at)
       select 'seed-' || i, md5(i::text) || md5((i + 1)::text), (now() at time zone 'Asia/Tokyo')::date, now() - interval '1 hour'
         from generate_series(1, 300) i`,
    );
    expect(await reserve(USER_B)).toBe("shop_daily_limit");
    expect(await count()).toBe(300);
  });

  it("日付が変わればリセットされる（前日分は 1 日の上限に数えない）", async () => {
    await db.query(
      `insert into public.ai_usage_reservations (webhook_event_id, user_key, jst_date, reserved_at)
       select 'seed-' || i, encode(sha256(convert_to($1, 'UTF8')), 'hex'),
              (now() at time zone 'Asia/Tokyo')::date - 1, now() - interval '1 day'
         from generate_series(1, 300) i`,
      [USER_A],
    );
    expect(await reserve()).toBe("reserved");
  });

  it("日付は日本時間で判定する（UTC 15:00 で日付が変わる）", async () => {
    const r = await db.query<{ before: string; after: string }>(
      `select ('2026-11-12T14:59:59Z'::timestamptz at time zone 'Asia/Tokyo')::date::text as before,
              ('2026-11-12T15:00:00Z'::timestamptz at time zone 'Asia/Tokyo')::date::text as after`,
    );
    expect(r.rows[0]).toEqual({ before: "2026-11-12", after: "2026-11-13" });
    await reserve();
    const today = await db.query<{ ok: boolean }>(
      "select jst_date = (now() at time zone 'Asia/Tokyo')::date as ok from public.ai_usage_reservations",
    );
    expect(today.rows[0].ok).toBe(true);
  });

  it("2 日より古い記録は確保時に削除する", async () => {
    await seedUsage(USER_A, 3, "now() - interval '3 days'");
    await seedUsage(USER_A, 2, "now() - interval '1 day'");
    await reserve(USER_B);
    expect(await count()).toBe(3);
  });

  it("LINE ユーザー ID はそのまま保存せず、SHA-256 のハッシュ値だけを保存する", async () => {
    await reserve(USER_A);
    const rows = (await db.query<Record<string, string>>("select * from public.ai_usage_reservations")).rows;
    expect(JSON.stringify(rows)).not.toContain(USER_A);
    expect(rows[0].user_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["不正なユーザー ID", ["ev", "not-a-user", 5, 30, 300], /invalid line user id/],
    ["空のイベント ID", ["", USER_A, 5, 30, 300], /invalid webhook event id/],
    ["上限 0", ["ev", USER_A, 0, 30, 300], /invalid usage limit/],
    ["上限 null", ["ev", USER_A, 5, null, 300], /invalid usage limit/],
    ["10 分間の上限が最大値（20）超", ["ev", USER_A, 21, 30, 300], /invalid usage limit/],
    ["1 日の上限が最大値（100）超", ["ev", USER_A, 5, 101, 300], /invalid usage limit/],
    ["店舗の上限が最大値（1000）超", ["ev", USER_A, 5, 30, 1001], /invalid usage limit/],
  ])("%s は例外（呼び出し側は AI を呼ばない）", async (_l, args, error) => {
    await expect(as("service_role", "select public.reserve_ai_usage($1, $2, $3, $4, $5)", args)).rejects.toThrow(error);
    expect(await count()).toBe(0);
  });
});

describe("同時リクエスト", () => {
  it("同じユーザーの 10 件を並列に確保しても、成功は 5 件だけ", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        db.query<{ r: string }>("select public.reserve_ai_usage($1, $2) as r", [nextId(), USER_A]),
      ),
    );
    const reasons = results.map((x) => x.rows[0].r);
    expect(reasons.filter((r) => r === "reserved")).toHaveLength(5);
    expect(reasons.filter((r) => r === "user_burst_limit")).toHaveLength(5);
    expect(await count()).toBe(5);
  });

  it("同じイベントを並列に確保しても、成功は 1 件だけ", async () => {
    const id = nextId();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => db.query<{ r: string }>("select public.reserve_ai_usage($1, $2) as r", [id, USER_A])),
    );
    expect(results.map((x) => x.rows[0].r).sort()).toEqual(["duplicate", "duplicate", "duplicate", "duplicate", "reserved"]);
  });

  it("READ COMMITTED 以外のトランザクションでは例外（ロック前のスナップショットで数えて上限を超えるのを防ぐ）", async () => {
    await db.exec("begin isolation level repeatable read");
    try {
      await expect(db.query("select public.reserve_ai_usage($1, $2)", [nextId(), USER_A])).rejects.toThrow(/read committed/);
    } finally {
      await db.exec("rollback");
    }
    expect(await count()).toBe(0);
    // 既定（READ COMMITTED）では確保できる
    expect(await reserve()).toBe("reserved");
  });

  it("確認と確保はアドバイザリーロックで直列化する実装になっている", async () => {
    const r = await db.query<{ src: string }>(
      "select prosrc as src from pg_proc where oid = to_regprocedure('public.reserve_ai_usage(text,text,integer,integer,integer)')",
    );
    const src = r.rows[0].src;
    // ロックを取ってから件数を数える（順序が逆だと同時実行で上限を超えうる）
    expect(src.indexOf("pg_advisory_xact_lock")).toBeGreaterThan(-1);
    expect(src.indexOf("pg_advisory_xact_lock")).toBeLessThan(src.indexOf("count(*)"));
  });
});

describe("適用前チェック（precheck-ai-usage-limits.sql・読み取り専用）", () => {
  const PRECHECK = join(process.cwd(), "scripts", "supabase", "precheck-ai-usage-limits.sql");
  async function withHistory(d: PGlite, files: string[]) {
    await d.exec("create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key)");
    for (const f of files) await d.query("insert into supabase_migrations.schema_migrations values ($1)", [f.slice(0, 14)]);
    return d;
  }
  const run = async (d: PGlite) => (await d.query<{ result: string; item: string }>(readFileSync(PRECHECK, "utf8"))).rows;
  const beforeSixth = () => migrationFiles().filter((f) => f < SIXTH);

  it("5 本適用済み・6 本目未適用の状態なら全項目 OK", async () => {
    const rows = await run(await withHistory(await createDbWithMigrations(beforeSixth()), beforeSixth()));
    expect(rows.length).toBeGreaterThanOrEqual(13);
    expect(rows.filter((r) => r.result !== "OK")).toEqual([]);
  });

  it("6 本目が適用済みなら NG（二重適用を防ぐ）", async () => {
    const ng = (await run(await withHistory(await createMigratedDb(), migrationFiles())))
      .filter((r) => r.result === "NG")
      .map((r) => r.item);
    expect(ng).toEqual(
      expect.arrayContaining([
        "適用履歴が 5 本（1〜5 本目）で、6 本目は未適用",
        "追加するテーブル ai_usage_reservations がまだ存在しない",
        "追加する関数 reserve_ai_usage がまだ存在しない（同名の関数もない）",
      ]),
    );
  });

  it("同名の関数が既にある（別のシグネチャでも）なら NG", async () => {
    const d = await withHistory(await createDbWithMigrations(beforeSixth()), beforeSixth());
    await d.exec("create function public.reserve_ai_usage(text) returns text language sql as $$ select 'x' $$");
    expect((await run(d)).filter((r) => r.result === "NG").map((r) => r.item)).toEqual([
      "追加する関数 reserve_ai_usage がまだ存在しない（同名の関数もない）",
    ]);
  });
});

describe("権限", () => {
  it.each([
    ["anon", "select public.reserve_ai_usage('ev', '" + USER_A + "')"],
    ["authenticated", "select public.reserve_ai_usage('ev', '" + USER_A + "')"],
    ["anon", "select * from public.ai_usage_reservations"],
    ["authenticated", "select * from public.ai_usage_reservations"],
  ] as const)("%s は実行・参照できない：%s", async (role, sql) => {
    await expect(as(role, sql)).rejects.toThrow(DENIED);
  });

  it.each([
    ["update public.ai_usage_reservations set jst_date = jst_date"],
    ["truncate public.ai_usage_reservations"],
  ])("service_role でも記録の書き換え・全削除はできない：%s", async (sql) => {
    await expect(as("service_role", sql)).rejects.toThrow(DENIED);
  });

  it("RLS が有効でポリシーはない", async () => {
    const r = await db.query<{ rls: boolean; policies: number }>(
      `select relrowsecurity as rls,
              (select count(*)::int from pg_policies where tablename = 'ai_usage_reservations') as policies
         from pg_class where oid = 'public.ai_usage_reservations'::regclass`,
    );
    expect(r.rows[0]).toEqual({ rls: true, policies: 0 });
  });

  it("取り消し用 SQL（手動用）でテーブルと関数を削除できる", async () => {
    await reserve();
    const sql = readFileSync(join(process.cwd(), "scripts", "supabase", "rollback", "20261113000000_ai_usage_limits.down.sql"), "utf8");
    await db.exec(sql);
    const r = await db.query<{ t: string | null; f: string | null }>(
      "select to_regclass('public.ai_usage_reservations')::text as t, to_regprocedure('public.reserve_ai_usage(text,text,integer,integer,integer)')::text as f",
    );
    expect(r.rows[0]).toEqual({ t: null, f: null });
  });

  it("6 本目は既存のテーブル・関数・権限を変更しない（5 本目まで適用した状態と比べて追加のみ）", async () => {
    const before = await createDbWithMigrations(migrationFiles().filter((f) => f < SIXTH));
    const q = (d: PGlite) =>
      d.query<Record<string, unknown>>(
        `select n.nspname, p.proname, md5(p.prosrc) as src, coalesce(p.proacl::text, '') as acl
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'private') and p.proname <> 'reserve_ai_usage' order by 1, 2, 3`,
      );
    const grants = (d: PGlite) =>
      d.query<Record<string, unknown>>(
        `select table_name, grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and table_name <> 'ai_usage_reservations' order by 1, 2, 3`,
      );
    const policies = (d: PGlite) => d.query("select tablename, policyname, cmd, qual from pg_policies order by 1, 2");
    // 7 本目以降の追加分を含めないよう、6 本目まで適用した DB と比べる
    const after = await createDbWithMigrations(migrationFiles().filter((f) => f <= SIXTH));
    expect((await q(after)).rows).toEqual((await q(before)).rows);
    expect((await grants(after)).rows).toEqual((await grants(before)).rows);
    expect((await policies(after)).rows).toEqual((await policies(before)).rows);
  });
});
