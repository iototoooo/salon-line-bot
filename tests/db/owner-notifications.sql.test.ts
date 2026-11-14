import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDbWithMigrations, createMigratedDb, migrationFiles } from "./pglite";

/**
 * 7 本目のマイグレーション（オーナー通知：owner_notification_batches /
 * claim_owner_notification_batch / finish_owner_notification_batch）を PGlite で検証する。
 * 実際の Supabase には接続しない。
 */
// PGlite の DB を複数作るテストがあり、並列実行時に既定の 5 秒を超えることがあるため延ばす
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SEVENTH = "20261114000000_owner_notifications.sql";
const USER = `U${"c".repeat(32)}`;
const DENIED = /permission denied/;

type Claim = {
  result: string;
  batch_id?: string;
  retry_key?: string;
  event_ids?: string[];
  pending_count?: number;
  urgent?: boolean;
  attempt?: number;
};

let db: PGlite;
let seq = 0;
const nextId = () => `01NOTIFY${String(++seq).padStart(10, "0")}`;

async function as(role: "anon" | "authenticated" | "service_role", sql: string, params: unknown[] = []) {
  await db.exec(`set role ${role}`);
  try {
    return await db.query<Record<string, unknown>>(sql, params);
  } finally {
    await db.exec("reset role");
  }
}

/** service_role としてまとめを確保する（既定：間隔 10 分・1 日 5 通・再送 3 回） */
async function claim(urgent = false, limits: [number, number, number] = [10, 5, 3]): Promise<Claim> {
  const r = await as("service_role", "select public.claim_owner_notification_batch($1, $2, $3, $4) as r", [urgent, ...limits]);
  return r.rows[0].r as Claim;
}

async function finish(batchId: string, result: string, error: string | null = null): Promise<boolean> {
  const r = await as("service_role", "select public.finish_owner_notification_batch($1, $2, $3) as r", [batchId, result, error]);
  return r.rows[0].r as boolean;
}

/** 処理済みのイベントを用意する（postgres として。受信時刻をずらすため） */
async function seedEvent(opts: { needs?: boolean; notified?: boolean; receivedAt?: string } = {}) {
  const id = nextId();
  const at = opts.receivedAt ?? "now()";
  await db.query(
    `insert into public.line_webhook_events
       (webhook_event_id, event_type, status, received_at, processing_started_at, processed_at,
        needs_owner_notification, owner_notified_at)
     values ($1, 'message', 'done', ${at}, ${at}, ${at}, $2, case when $3 then now() end)`,
    [id, opts.needs ?? true, opts.notified ?? false],
  );
  return id;
}

async function seedConversation(eventId: string, needsOwner = true) {
  await db.query(
    `insert into public.conversations (line_event_id, line_user_id, message_type, user_message, ai_status, needs_owner)
     values ($1, $2, 'text', 'シャンプーは売っていますか', 'cannot_answer', $3)`,
    [eventId, USER, needsOwner],
  );
}

/** 送信記録の時刻を過去にずらす（間隔の判定を進める） */
const ageBatches = (minutes: number) =>
  db.exec(
    `update public.owner_notification_batches
        set last_attempt_at = last_attempt_at - interval '${minutes} minutes',
            created_at = created_at - interval '${minutes} minutes'`,
  );

const notifiedAt = async (id: string) =>
  (await db.query<{ t: string | null }>("select owner_notified_at as t from public.line_webhook_events where webhook_event_id = $1", [id]))
    .rows[0].t;
const batchCount = async () =>
  Number((await db.query<{ n: number }>("select count(*)::int as n from public.owner_notification_batches")).rows[0].n);

beforeEach(async () => {
  db = await createMigratedDb();
});

describe("まとめの確保（claim_owner_notification_batch）", () => {
  it("未通知のイベントがなければ nothing（送信記録も作らない）", async () => {
    await seedEvent({ needs: false });
    await seedEvent({ notified: true });
    expect(await claim()).toEqual({ result: "nothing" });
    expect(await batchCount()).toBe(0);
  });

  it("未通知のイベントをすべて 1 つのまとめにする（新しい順・通知済み・対象外・7 日より前は除く）", async () => {
    const older = await seedEvent({ receivedAt: "now() - interval '2 hours'" });
    const newer = await seedEvent({ receivedAt: "now() - interval '1 minute'" });
    await seedEvent({ needs: false });
    await seedEvent({ notified: true });
    await seedEvent({ receivedAt: "now() - interval '8 days'" });

    const c = await claim();
    expect(c).toMatchObject({ result: "claimed", event_ids: [newer, older], pending_count: 2, urgent: false, attempt: 1 });
    expect(c.retry_key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("1 つのまとめに含めるのは 200 件まで（件数は全体を返し、残りは次のまとめへ）", async () => {
    await db.exec(
      `insert into public.line_webhook_events
         (webhook_event_id, event_type, status, received_at, processing_started_at, processed_at, needs_owner_notification)
       select 'bulk-' || lpad(i::text, 4, '0'), 'message', 'done', now() - make_interval(secs => i), now(), now(), true
         from generate_series(1, 205) i`,
    );
    const c = await claim();
    expect(c.event_ids).toHaveLength(200);
    expect(c.pending_count).toBe(205);
    expect(c.event_ids?.[0]).toBe("bulk-0001");
  });

  it("送信済みにすると、イベントと会話ログ（要オーナー対応のもの）に通知日時を記録する", async () => {
    const id = await seedEvent();
    await seedConversation(id);
    const c = await claim();
    expect(await finish(c.batch_id!, "sent")).toBe(true);

    expect(await notifiedAt(id)).not.toBeNull();
    const conv = await db.query<{ t: string | null }>("select owner_notified_at as t from public.conversations where line_event_id = $1", [id]);
    expect(conv.rows[0].t).not.toBeNull();
    const b = await db.query<Record<string, unknown>>("select status, finished_at, last_error from public.owner_notification_batches");
    expect(b.rows[0]).toMatchObject({ status: "sent", last_error: null });
    expect(b.rows[0].finished_at).not.toBeNull();
  });

  it("要オーナー対応でない会話ログには通知日時を付けない", async () => {
    const id = await seedEvent();
    await seedConversation(id, false);
    await finish((await claim()).batch_id!, "sent");
    const conv = await db.query<{ t: string | null }>("select owner_notified_at as t from public.conversations where line_event_id = $1", [id]);
    expect(conv.rows[0].t).toBeNull();
  });

  it("送信中のまとめがあれば busy（同じイベントを二重に送らない）", async () => {
    await seedEvent();
    expect((await claim()).result).toBe("claimed");
    await seedEvent();
    expect(await claim()).toEqual({ result: "busy" });
    expect(await batchCount()).toBe(1);
  });

  it("前回の送信から 10 分以内は throttled。過ぎれば、その間の分を 1 通にまとめる", async () => {
    await seedEvent();
    await finish((await claim()).batch_id!, "sent");
    const a = await seedEvent();
    const b = await seedEvent();
    expect(await claim()).toEqual({ result: "throttled" });

    await ageBatches(11);
    const c = await claim();
    expect(c.result).toBe("claimed");
    expect([...(c.event_ids ?? [])].sort()).toEqual([a, b].sort());
  });

  it("日本時間の 1 日に 5 通まで。超えたら daily_limit（イベントは未通知のまま残る）", async () => {
    for (let i = 0; i < 5; i++) {
      await seedEvent();
      await finish((await claim()).batch_id!, "sent");
      await ageBatches(11);
    }
    const id = await seedEvent();
    expect(await claim()).toEqual({ result: "daily_limit" });
    expect(await notifiedAt(id)).toBeNull();
  });

  it("前日分の送信は 1 日の上限に数えない", async () => {
    await db.exec(
      `insert into public.owner_notification_batches (event_ids, status, jst_date, created_at, last_attempt_at, finished_at)
       select array['old-' || i], 'sent', (now() at time zone 'Asia/Tokyo')::date - 1,
              now() - interval '1 day', now() - interval '1 day', now() - interval '1 day'
         from generate_series(1, 5) i`,
    );
    await seedEvent();
    expect((await claim()).result).toBe("claimed");
  });

  it("店舗全体の AI 利用上限の通知（urgent）は 1 日 1 回だけ、間隔・上限を無視して送れる", async () => {
    await seedEvent();
    await finish((await claim()).batch_id!, "sent");
    await seedEvent();
    expect(await claim()).toEqual({ result: "throttled" });

    const u = await claim(true);
    expect(u).toMatchObject({ result: "claimed", urgent: true });
    await finish(u.batch_id!, "sent");

    // 2 回目の urgent は通常の扱い（間隔の制限を受ける）
    await seedEvent();
    expect(await claim(true)).toEqual({ result: "throttled" });
    await ageBatches(11);
    expect(await claim(true)).toMatchObject({ result: "claimed", urgent: false });
  });

  it("urgent でも、未通知のイベントがなければ送らない", async () => {
    expect(await claim(true)).toEqual({ result: "nothing" });
  });

  it("30 日より古い送信記録は確保時に削除する", async () => {
    await db.exec(
      `insert into public.owner_notification_batches (event_ids, status, jst_date, created_at, last_attempt_at, finished_at)
       values (array['old'], 'sent', '2026-01-01', now() - interval '31 days', now() - interval '31 days', now() - interval '31 days')`,
    );
    await claim();
    expect(await batchCount()).toBe(0);
  });

  it.each([
    ["urgent が null", [null, 10, 5, 3]],
    ["間隔 0 分", [false, 0, 5, 3]],
    ["間隔が 1 日超", [false, 1441, 5, 3]],
    ["1 日の上限 0", [false, 10, 0, 3]],
    ["1 日の上限が最大値（50）超", [false, 10, 51, 3]],
    ["再送回数が最大値（5）超", [false, 10, 5, 6]],
  ])("%s は例外", async (_l, args) => {
    await seedEvent();
    await expect(as("service_role", "select public.claim_owner_notification_batch($1, $2, $3, $4)", args)).rejects.toThrow(
      /invalid owner notification limit/,
    );
    expect(await batchCount()).toBe(0);
  });
});

describe("送信結果と再送（finish_owner_notification_batch）", () => {
  it("LINE が拒否（failed）なら、対象は未通知のまま次のまとめに含まれる（新しい再送キー）", async () => {
    const id = await seedEvent();
    const first = await claim();
    expect(await finish(first.batch_id!, "failed", "push_http_400")).toBe(true);
    expect(await notifiedAt(id)).toBeNull();

    expect(await claim()).toEqual({ result: "throttled" });
    await ageBatches(11);
    const next = await claim();
    expect(next).toMatchObject({ result: "claimed", event_ids: [id] });
    expect(next.retry_key).not.toBe(first.retry_key);
  });

  it("成否不明（unknown）は、間隔をおいて同じ再送キー・同じ対象で再送する。新しいイベントは混ぜない", async () => {
    const id = await seedEvent();
    const first = await claim();
    await finish(first.batch_id!, "unknown", "push_timeout");
    const later = await seedEvent();

    expect(await claim()).toEqual({ result: "throttled" });
    await ageBatches(11);
    const retry = await claim();
    expect(retry).toMatchObject({
      result: "retry",
      batch_id: first.batch_id,
      retry_key: first.retry_key,
      event_ids: [id],
      attempt: 2,
    });

    await finish(retry.batch_id!, "sent");
    expect(await notifiedAt(id)).not.toBeNull();
    expect(await notifiedAt(later)).toBeNull();
  });

  it("再送は 3 回まで。超えたら打ち切り、対象は新しいまとめに含める", async () => {
    const id = await seedEvent();
    const first = await claim();
    await finish(first.batch_id!, "unknown");
    for (let attempt = 2; attempt <= 3; attempt++) {
      await ageBatches(11);
      const r = await claim();
      expect(r).toMatchObject({ result: "retry", attempt });
      await finish(r.batch_id!, "unknown");
    }
    await ageBatches(11);
    const next = await claim();
    expect(next).toMatchObject({ result: "claimed", event_ids: [id] });
    expect(next.retry_key).not.toBe(first.retry_key);
    const old = await db.query<{ status: string; last_error: string }>(
      "select status, last_error from public.owner_notification_batches where id = $1",
      [first.batch_id],
    );
    expect(old.rows[0]).toEqual({ status: "abandoned", last_error: "retry_exhausted" });
  });

  it("作成から 23 時間を過ぎた成否不明のまとめは再送しない（LINE の再送キーの有効期間は 24 時間）", async () => {
    await seedEvent();
    const first = await claim();
    await finish(first.batch_id!, "unknown");
    await ageBatches(23 * 60 + 1);
    const next = await claim();
    expect(next.result).toBe("claimed");
    expect(next.batch_id).not.toBe(first.batch_id);
  });

  it("送信中のまま 2 分以上たったまとめ（処理の停止）は成否不明として同じキーで再送する", async () => {
    await seedEvent();
    const first = await claim();
    await ageBatches(11);
    const retry = await claim();
    expect(retry).toMatchObject({ result: "retry", batch_id: first.batch_id, retry_key: first.retry_key, attempt: 2 });
  });

  it("結果の記録は送信中のまとめに 1 回だけ", async () => {
    await seedEvent();
    const c = await claim();
    expect(await finish(c.batch_id!, "sent")).toBe(true);
    expect(await finish(c.batch_id!, "failed")).toBe(false);
    expect(await finish("00000000-0000-0000-0000-000000000000", "sent")).toBe(false);
  });

  it.each([
    ["不正な結果", "done", null, /invalid owner notification result/],
    ["本文を含みうるエラー（大文字・空白）", "failed", "LINE error: blocked", /invalid owner notification error code/],
  ])("%s は例外", async (_l, result, error, message) => {
    await seedEvent();
    const c = await claim();
    await expect(
      as("service_role", "select public.finish_owner_notification_batch($1, $2, $3)", [c.batch_id, result, error]),
    ).rejects.toThrow(message);
  });
});

describe("同時実行", () => {
  it("並列に 5 回確保しても、まとめは 1 つだけ（残りは busy）", async () => {
    await seedEvent();
    await seedEvent();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        db.query<{ r: Claim }>("select public.claim_owner_notification_batch() as r"),
      ),
    );
    const kinds = results.map((x) => x.rows[0].r.result).sort();
    expect(kinds).toEqual(["busy", "busy", "busy", "busy", "claimed"]);
    expect(await batchCount()).toBe(1);
  });

  it("READ COMMITTED 以外のトランザクションでは例外", async () => {
    await seedEvent();
    await db.exec("begin isolation level repeatable read");
    try {
      await expect(db.query("select public.claim_owner_notification_batch()")).rejects.toThrow(/read committed/);
    } finally {
      await db.exec("rollback");
    }
    expect(await batchCount()).toBe(0);
  });

  it("確認と確保はアドバイザリーロックで直列化する実装になっている（6 本目とは別のキー）", async () => {
    const r = await db.query<{ src: string }>(
      "select prosrc as src from pg_proc where oid = to_regprocedure('public.claim_owner_notification_batch(boolean,integer,integer,integer)')",
    );
    const src = r.rows[0].src;
    expect(src).toContain("pg_advisory_xact_lock(7461801206180002)");
    expect(src.indexOf("pg_advisory_xact_lock")).toBeLessThan(src.indexOf("count(*)"));
  });
});

describe("適用前チェック（precheck-owner-notifications.sql・読み取り専用）", () => {
  const PRECHECK = join(process.cwd(), "scripts", "supabase", "precheck-owner-notifications.sql");
  const beforeSeventh = () => migrationFiles().filter((f) => f < SEVENTH);
  async function withHistory(d: PGlite, files: string[]) {
    await d.exec("create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key)");
    for (const f of files) await d.query("insert into supabase_migrations.schema_migrations values ($1)", [f.slice(0, 14)]);
    return d;
  }
  // 本番と同じく読み取り専用トランザクションで実行し、データを変更しないことも確認する
  async function run(d: PGlite) {
    await d.exec("begin read only");
    try {
      return (await d.query<{ result: string; item: string; detail: string }>(readFileSync(PRECHECK, "utf8"))).rows;
    } finally {
      await d.exec("rollback");
    }
  }
  const ngOf = async (d: PGlite) => (await run(d)).filter((r) => r.result !== "OK").map((r) => r.item);

  it("6 本適用済み・7 本目未適用の状態なら全項目 OK", async () => {
    const rows = await run(await withHistory(await createDbWithMigrations(beforeSeventh()), beforeSeventh()));
    expect(rows.length).toBeGreaterThanOrEqual(18);
    expect(rows.filter((r) => r.result !== "OK")).toEqual([]);
  });

  it("通知先は有無だけを表示し、値（LINE ユーザー ID）は表示しない", async () => {
    const d = await withHistory(await createDbWithMigrations(beforeSeventh()), beforeSeventh());
    expect((await run(d)).find((r) => r.item.includes("通知先"))?.detail).toBe("未設定（適用後も通知は送られない）");
    await d.query("update public.shop_settings set owner_line_user_id = $1", [USER]);
    const rows = await run(d);
    expect(rows.find((r) => r.item.includes("通知先"))?.detail).toBe("設定済み");
    expect(JSON.stringify(rows)).not.toContain(USER);
  });

  it("適用後に最初の通知の対象になるイベント数を表示する（7 日より前・通知済みは数えない）", async () => {
    const d = await withHistory(await createDbWithMigrations(beforeSeventh()), beforeSeventh());
    db = d;
    await seedEvent();
    await seedEvent({ notified: true });
    await seedEvent({ receivedAt: "now() - interval '8 days'" });
    expect((await run(d)).find((r) => r.item.includes("最初の通知の対象"))?.detail).toBe("1");
  });

  it("7 本目が適用済みなら NG（二重適用を防ぐ）", async () => {
    const ng = await ngOf(await withHistory(await createMigratedDb(), migrationFiles()));
    expect(ng).toEqual(
      expect.arrayContaining([
        "適用履歴が 6 本（1〜6 本目）で、7 本目は未適用",
        "追加するテーブル owner_notification_batches がまだ存在しない",
        "追加する関数がまだ存在しない（claim_owner_notification_batch・finish_owner_notification_batch。同名の関数もない）",
        "追加するインデックス名がまだ存在しない",
        "アドバイザリーロックのキー 7461801206180002 を他の関数が使っていない",
        "public のテーブルが想定の 8 つだけ",
      ]),
    );
  });

  it.each([
    ["同名の関数が既にある（別のシグネチャでも）", "create function public.finish_owner_notification_batch(text) returns text language sql as $$ select 'x' $$",
      "追加する関数がまだ存在しない（claim_owner_notification_batch・finish_owner_notification_batch。同名の関数もない）"],
    ["同じロックのキーを使う関数がある", "create function public.other_lock() returns void language sql as $$ select pg_advisory_xact_lock(7461801206180002) $$",
      "アドバイザリーロックのキー 7461801206180002 を他の関数が使っていない"],
    ["service_role の更新権限がない", "revoke update on public.line_webhook_events from service_role",
      "依存：service_role は line_webhook_events・conversations を参照・更新できる（3 本目）"],
    ["未通知用インデックスがない", "drop index public.line_webhook_events_owner_pending_idx",
      "依存：line_webhook_events の要通知・通知日時の列と制約・未通知用インデックスがある（2 本目）"],
    ["自動応答が ON", "update public.shop_settings set bot_enabled = true", "shop_settings：1 行・自動応答は OFF"],
  ])("%s なら NG", async (_l, sabotage, item) => {
    const d = await withHistory(await createDbWithMigrations(beforeSeventh()), beforeSeventh());
    await d.exec(sabotage);
    expect(await ngOf(d)).toEqual([item]);
  });
});

describe("権限・個人情報", () => {
  it.each([
    ["anon", "select public.claim_owner_notification_batch()"],
    ["authenticated", "select public.claim_owner_notification_batch()"],
    ["anon", "select public.finish_owner_notification_batch(gen_random_uuid(), 'sent')"],
    ["authenticated", "select public.finish_owner_notification_batch(gen_random_uuid(), 'sent')"],
    ["anon", "select * from public.owner_notification_batches"],
    ["authenticated", "select * from public.owner_notification_batches"],
  ] as const)("%s は実行・参照できない：%s", async (role, sql) => {
    await expect(as(role, sql)).rejects.toThrow(DENIED);
  });

  it("service_role でも全削除（TRUNCATE）はできない", async () => {
    await expect(as("service_role", "truncate public.owner_notification_batches")).rejects.toThrow(DENIED);
  });

  it("RLS が有効でポリシーはない", async () => {
    const r = await db.query<{ rls: boolean; policies: number }>(
      `select relrowsecurity as rls,
              (select count(*)::int from pg_policies where tablename = 'owner_notification_batches') as policies
         from pg_class where oid = 'public.owner_notification_batches'::regclass`,
    );
    expect(r.rows[0]).toEqual({ rls: true, policies: 0 });
  });

  it("送信記録にはユーザー ID・本文を保存しない（イベント ID とコードのみ）", async () => {
    const id = await seedEvent();
    await seedConversation(id);
    await finish((await claim()).batch_id!, "failed", "push_http_400");
    const rows = (await db.query<Record<string, unknown>>("select * from public.owner_notification_batches")).rows;
    const text = JSON.stringify(rows);
    expect(text).not.toContain(USER);
    expect(text).not.toContain("シャンプー");
    const cols = await db.query<{ c: string }>(
      "select column_name as c from information_schema.columns where table_schema = 'public' and table_name = 'owner_notification_batches' order by 1",
    );
    expect(cols.rows.map((r) => r.c)).toEqual([
      "attempts", "created_at", "event_ids", "finished_at", "id", "jst_date", "last_attempt_at", "last_error", "retry_key", "status", "urgent",
    ]);
  });

  it("取り消し用 SQL（手動用）でテーブルと関数を削除できる", async () => {
    await seedEvent();
    await claim();
    await db.exec(
      readFileSync(join(process.cwd(), "scripts", "supabase", "rollback", "20261114000000_owner_notifications.down.sql"), "utf8"),
    );
    const r = await db.query<Record<string, string | null>>(
      `select to_regclass('public.owner_notification_batches')::text as t,
              to_regprocedure('public.claim_owner_notification_batch(boolean,integer,integer,integer)')::text as c,
              to_regprocedure('public.finish_owner_notification_batch(uuid,text,text)')::text as f`,
    );
    expect(r.rows[0]).toEqual({ t: null, c: null, f: null });
  });

  it("7 本目は既存のテーブル・関数・権限を変更しない（6 本目まで適用した状態と比べて追加のみ）", async () => {
    const before = await createDbWithMigrations(migrationFiles().filter((f) => f < SEVENTH));
    // 8 本目以降の追加分は除いて比べる
    db = await createDbWithMigrations(migrationFiles().filter((f) => f <= SEVENTH));
    const fns = (d: PGlite) =>
      d.query<Record<string, unknown>>(
        `select n.nspname, p.proname, md5(p.prosrc) as src, coalesce(p.proacl::text, '') as acl
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'private')
            and p.proname not in ('claim_owner_notification_batch', 'finish_owner_notification_batch')
          order by 1, 2, 3`,
      );
    const grants = (d: PGlite) =>
      d.query<Record<string, unknown>>(
        `select table_name, grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and table_name <> 'owner_notification_batches' order by 1, 2, 3`,
      );
    const columns = (d: PGlite) =>
      d.query<Record<string, unknown>>(
        `select table_name, column_name, data_type from information_schema.columns
          where table_schema = 'public' and table_name <> 'owner_notification_batches' order by 1, 2`,
      );
    const policies = (d: PGlite) => d.query("select tablename, policyname, cmd, qual from pg_policies order by 1, 2");
    expect((await fns(db)).rows).toEqual((await fns(before)).rows);
    expect((await grants(db)).rows).toEqual((await grants(before)).rows);
    expect((await columns(db)).rows).toEqual((await columns(before)).rows);
    expect((await policies(db)).rows).toEqual((await policies(before)).rows);
  });
});
