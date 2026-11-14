import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDbWithMigrations, createMigratedDb, migrationFiles } from "./pglite";

/**
 * 8 本目のマイグレーション（public.run_retention_purge：保持期間を過ぎたデータの定期削除）を PGlite で検証する。
 * 実際の Supabase には接続しない。
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const EIGHTH = "20261115000000_retention_purge.sql";
const USER = `U${"d".repeat(32)}`;
const ADMIN = "00000000-0000-4000-8000-0000000000a1";

type Purge = {
  result: string;
  conversations?: number;
  line_webhook_events?: number;
  ai_usage_reservations?: number;
  owner_notification_batches?: number;
};

let db: PGlite;
let seq = 0;

async function as(role: "anon" | "authenticated" | "service_role", sql: string, params: unknown[] = []) {
  await db.exec(`set role ${role}`);
  try {
    return await db.query<Record<string, unknown>>(sql, params);
  } finally {
    await db.exec("reset role");
  }
}

const purge = async (): Promise<Purge> => (await as("service_role", "select public.run_retention_purge() as r")).rows[0].r as Purge;
const count = async (t: string) => Number((await db.query<{ n: number }>(`select count(*)::int as n from public.${t}`)).rows[0].n);

/** 指定した日数前の会話を 1 件作る（postgres として。作成日時をずらすため） */
async function seedConversation(ageDays: number, opts: { needsOwner?: boolean; resolvedBy?: string } = {}) {
  const id = `01CONV${String(++seq).padStart(10, "0")}`;
  await db.query(
    `insert into public.conversations
       (line_event_id, line_user_id, message_type, user_message, ai_status, needs_owner, resolved_at, resolved_by, created_at)
     values ($1, $2, 'text', 'テスト', 'answered', $3, $4, $5, now() - make_interval(secs => $6::float8 * 86400))`,
    [id, USER, opts.needsOwner ?? false, opts.resolvedBy ? new Date().toISOString() : null, opts.resolvedBy ?? null, ageDays],
  );
  return id;
}

async function seedEvent(ageDays: number) {
  const id = `01EVT${String(++seq).padStart(10, "0")}`;
  await db.query(
    `insert into public.line_webhook_events (webhook_event_id, event_type, status, received_at, processed_at)
     values ($1, 'message', 'done', now() - make_interval(secs => $2::float8 * 86400), now() - make_interval(secs => $2::float8 * 86400))`,
    [id, ageDays],
  );
  return id;
}

async function seedUsage(ageDays: number) {
  await db.query(
    `insert into public.ai_usage_reservations (webhook_event_id, user_key, jst_date, reserved_at)
     values ($1, $2, (now() at time zone 'Asia/Tokyo')::date, now() - make_interval(secs => $3::float8 * 86400))`,
    [`01USE${String(++seq).padStart(10, "0")}`, "a".repeat(64), ageDays],
  );
}

async function seedBatch(ageDays: number, status: "sent" | "failed" | "abandoned" | "sending" | "unknown") {
  const open = status === "sending" || status === "unknown";
  await db.query(
    `insert into public.owner_notification_batches (event_ids, status, jst_date, created_at, last_attempt_at, finished_at)
     values (array[$1], $2, '2026-01-01', now() - make_interval(secs => $3::float8 * 86400), now() - make_interval(secs => $3::float8 * 86400),
             case when $4 then null else now() - make_interval(secs => $3::float8 * 86400) end)`,
    [`01BAT${String(++seq).padStart(10, "0")}`, status, ageDays, open],
  );
}

beforeEach(async () => {
  db = await createMigratedDb();
});

describe("8 本目：保持期間を過ぎたデータの定期削除（run_retention_purge）", () => {
  it("マイグレーションのファイル名順で 8 本目", () => {
    expect(migrationFiles()[7]).toBe(EIGHTH);
  });

  it("会話は 90 日、Webhook イベントは 7 日、利用枠は 2 日、通知記録は 30 日を過ぎたものだけを削除する（境界の前後）", async () => {
    const keepConv = [await seedConversation(0), await seedConversation(89), await seedConversation(89.9)];
    await seedConversation(90.1);
    await seedConversation(91);
    await seedConversation(400);
    const keepEvt = [await seedEvent(0), await seedEvent(6.9)];
    await seedEvent(7.1);
    await seedEvent(8);
    await seedUsage(1.9);
    await seedUsage(2.1);
    await seedBatch(29, "sent");
    await seedBatch(31, "sent");
    await seedBatch(31, "failed");
    await seedBatch(31, "abandoned");

    expect(await purge()).toEqual({
      result: "purged",
      conversations: 3,
      line_webhook_events: 2,
      ai_usage_reservations: 1,
      owner_notification_batches: 3,
    });
    const convLeft = (await db.query<{ id: string }>("select line_event_id as id from public.conversations order by 1")).rows.map((r) => r.id);
    expect(convLeft).toEqual([...keepConv].sort());
    const evtLeft = (await db.query<{ id: string }>("select webhook_event_id as id from public.line_webhook_events order by 1")).rows.map((r) => r.id);
    expect(evtLeft).toEqual([...keepEvt].sort());
    expect(await count("ai_usage_reservations")).toBe(1);
    expect(await count("owner_notification_batches")).toBe(1);
  });

  it("未対応のまま 90 日を過ぎた会話も削除する（保持期間の方針どおり）", async () => {
    await seedConversation(91, { needsOwner: true });
    await seedConversation(10, { needsOwner: true });
    expect((await purge()).conversations).toBe(1);
    expect(await count("conversations")).toBe(1);
  });

  it("送信中・成否不明の通知記録は 30 日を過ぎても削除しない", async () => {
    await seedBatch(40, "sending");
    await seedBatch(40, "unknown");
    expect((await purge()).owner_notification_batches).toBe(0);
    expect(await count("owner_notification_batches")).toBe(2);
  });

  it("管理者・店舗情報・FAQ・メニュー・配信は、古くても削除しない。対応者の管理者も残る", async () => {
    await db.query("insert into auth.users (id) values ($1)", [ADMIN]);
    await db.query("insert into public.admin_users (user_id, created_at) values ($1, now() - interval '1000 days')", [ADMIN]);
    await db.query("insert into public.faqs (question, answer, created_at, updated_at) values ('Q', 'A', now() - interval '1000 days', now() - interval '1000 days')");
    await db.query("insert into public.menus (name, price, created_at, updated_at) values ('カット', 4000, now() - interval '1000 days', now() - interval '1000 days')");
    await db.query("insert into public.broadcasts (body, created_at, updated_at) values ('お知らせ', now() - interval '1000 days', now() - interval '1000 days')");
    await db.query("update public.shop_settings set updated_at = now() - interval '1000 days'");
    await seedConversation(10, { needsOwner: true, resolvedBy: ADMIN });
    const before = await Promise.all(["admin_users", "shop_settings", "faqs", "menus", "broadcasts"].map(count));

    await purge();

    expect(await Promise.all(["admin_users", "shop_settings", "faqs", "menus", "broadcasts"].map(count))).toEqual(before);
    expect(before).toEqual([1, 1, 1, 1, 1]);
    const r = await db.query<{ resolved_by: string }>("select resolved_by from public.conversations");
    expect(r.rows[0].resolved_by).toBe(ADMIN);
  });

  it("何度実行しても安全（2 回目は 0 件）。データがなくても成功する", async () => {
    await seedConversation(100);
    await seedEvent(10);
    expect((await purge()).conversations).toBe(1);
    expect(await purge()).toEqual({
      result: "purged",
      conversations: 0,
      line_webhook_events: 0,
      ai_usage_reservations: 0,
      owner_notification_batches: 0,
    });
  });

  it("別の削除処理が実行中（ロック取得済み）なら、何もせず busy を返す", async () => {
    await seedConversation(100);
    // 同じ接続でロックを持ったまま別のセッションから呼ぶことは PGlite ではできないため、
    // 関数がロックを試し、取れなければ何もしない作りであることをソースで確認する
    const src = (await db.query<{ s: string }>("select prosrc as s from pg_proc where proname = 'run_retention_purge'")).rows[0].s;
    const tryLock = src.indexOf("pg_try_advisory_xact_lock(7461801206180003)");
    expect(tryLock).toBeGreaterThan(-1);
    expect(src.indexOf("'busy'")).toBeGreaterThan(tryLock);
    expect(src.indexOf("purge_expired_data")).toBeGreaterThan(src.indexOf("'busy'"));
    // 通知のまとめの確保と同じロックで、削除と確保が重ならない
    expect(src).toContain("pg_advisory_xact_lock(7461801206180002)");
    const claimSrc = (await db.query<{ s: string }>("select prosrc as s from pg_proc where proname = 'claim_owner_notification_batch'")).rows[0].s;
    expect(claimSrc).toContain("pg_advisory_xact_lock(7461801206180002)");
  });

  it("引数で保持期間を変えて呼ぶことはできない（引数なしの関数だけ）", async () => {
    await expect(as("service_role", "select public.run_retention_purge(interval '1 day')")).rejects.toThrow(/does not exist/);
  });

  it.each(["anon", "authenticated"] as const)("%s は実行できない", async (role) => {
    await seedConversation(100);
    await expect(as(role, "select public.run_retention_purge()")).rejects.toThrow(/permission denied/);
    expect(await count("conversations")).toBe(1);
  });

  it("security invoker・search_path 固定・EXECUTE は service_role のみ", async () => {
    const r = await db.query<{ secdef: boolean; cfg: string[]; acl: string }>(
      "select prosecdef as secdef, proconfig as cfg, proacl::text as acl from pg_proc where proname = 'run_retention_purge'",
    );
    expect(r.rows[0].secdef).toBe(false);
    expect(r.rows[0].cfg).toContain("search_path=\"\"");
    const grantees = (await db.query<{ g: string }>(
      `select grantee as g from information_schema.routine_privileges
        where routine_schema = 'public' and routine_name = 'run_retention_purge' and privilege_type = 'EXECUTE' order by 1`,
    )).rows.map((x) => x.g);
    expect(grantees.filter((g) => g !== "postgres")).toEqual(["service_role"]);
  });

  it("戻り値は件数だけ（ID・本文・ユーザー ID を含まない）", async () => {
    await seedConversation(100);
    const text = JSON.stringify(await purge());
    expect(text).not.toContain(USER);
    expect(text).not.toContain("テスト");
    expect(text).not.toMatch(/01CONV/);
  });

  it("取り消し用 SQL（手動用）で関数だけを削除できる（テーブルと purge_expired_data は残る）", async () => {
    await db.exec(readFileSync(join(process.cwd(), "scripts", "supabase", "rollback", "20261115000000_retention_purge.down.sql"), "utf8"));
    const r = await db.query<Record<string, string | null>>(
      `select to_regprocedure('public.run_retention_purge()')::text as f,
              to_regprocedure('private.purge_expired_data(interval,interval)')::text as p,
              to_regclass('public.conversations')::text as c`,
    );
    expect(r.rows[0]).toEqual({ f: null, p: "private.purge_expired_data(interval,interval)", c: "conversations" });
  });

  it("8 本目は既存のテーブル・関数・権限を変更しない（7 本目まで適用した状態と比べて追加のみ）", async () => {
    const before = await createDbWithMigrations(migrationFiles().filter((f) => f < EIGHTH));
    const fns = (d: PGlite) =>
      d.query(
        `select n.nspname, p.proname, md5(p.prosrc) as src, coalesce(p.proacl::text, '') as acl
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'private') and p.proname <> 'run_retention_purge'
          order by 1, 2, 3`,
      );
    const grants = (d: PGlite) =>
      d.query("select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' order by 1, 2, 3");
    const columns = (d: PGlite) =>
      d.query("select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' order by 1, 2");
    const policies = (d: PGlite) => d.query("select tablename, policyname, cmd, qual from pg_policies order by 1, 2");
    expect((await fns(db)).rows).toEqual((await fns(before)).rows);
    expect((await grants(db)).rows).toEqual((await grants(before)).rows);
    expect((await columns(db)).rows).toEqual((await columns(before)).rows);
    expect((await policies(db)).rows).toEqual((await policies(before)).rows);
  });
});
