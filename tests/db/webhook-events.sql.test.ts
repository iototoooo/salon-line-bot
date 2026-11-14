import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asServiceRole, createMigratedDb, migrationFiles } from "./pglite";

/**
 * line_webhook_events とその関数を、ローカルの PostgreSQL（PGlite）で検証する。
 * 実際の Supabase には接続しない。PGlite は単一接続のため、並列性は
 * 「同時に発行したクエリが順に実行される」範囲での検証になる。
 */
let db: PGlite;

beforeAll(async () => {
  db = await createMigratedDb();
}, 60_000);

beforeEach(async () => {
  await db.exec("reset role; truncate public.line_webhook_events");
});

const claim = (id: string, redelivery = false) =>
  asServiceRole<{ ok: boolean }>(
    db,
    "select public.claim_line_webhook_event($1, 'message', $2, now()) as ok",
    [id, redelivery],
  ).then((r) => r.rows[0].ok);

const beginReply = (id: string) =>
  asServiceRole<{ ok: boolean }>(db, "select public.begin_line_reply($1) as ok", [id]).then((r) => r.rows[0].ok);

const recordReply = (id: string, result: string) =>
  asServiceRole<{ ok: boolean }>(db, "select public.record_line_reply_result($1, $2) as ok", [id, result]).then(
    (r) => r.rows[0].ok,
  );

const finish = (id: string, status: string, error: string | null = null, notify = false) =>
  asServiceRole<{ ok: boolean }>(db, "select public.finish_line_webhook_event($1, $2, $3, $4) as ok", [
    id,
    status,
    error,
    notify,
  ]).then((r) => r.rows[0].ok);

const row = (id: string) =>
  db
    .query<Record<string, unknown>>("select * from public.line_webhook_events where webhook_event_id = $1", [id])
    .then((r) => r.rows[0]);

describe("マイグレーション", () => {
  it("全マイグレーションが空の DB に順番どおり適用できる", () => {
    expect(migrationFiles()).toEqual([
      "20261110000000_initial_schema.sql",
      "20261110010000_webhook_event_processing.sql",
      "20261110020000_grant_service_role.sql",
      "20261111000000_reply_status_simulated.sql",
      "20261112000000_conversation_ai_sources.sql",
      "20261113000000_ai_usage_limits.sql",
      "20261114000000_owner_notifications.sql",
      "20261115000000_retention_purge.sql",
    ]);
  });
});

describe("claim_line_webhook_event", () => {
  it("初回登録は true で、processing・返信期限付きで記録される", async () => {
    expect(await claim("ev1")).toBe(true);
    const r = await row("ev1");
    expect(r.status).toBe("processing");
    expect(r.reply_status).toBe("none");
    const windowMs = (r.reply_deadline_at as Date).getTime() - (r.received_at as Date).getTime();
    expect(windowMs).toBe(50_000);
  });

  it("同じイベントの 2 回目（再配信を含む）は false", async () => {
    expect(await claim("ev1")).toBe(true);
    expect(await claim("ev1")).toBe(false);
    expect(await claim("ev1", true)).toBe(false);
  });

  it("並列に呼んでも true は 1 回だけ", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => claim("same")));
    expect(results.filter(Boolean)).toHaveLength(1);
    const count = await db.query<{ n: number }>("select count(*)::int as n from public.line_webhook_events");
    expect(count.rows[0].n).toBe(1);
  });

  it("返信期限は 1 分を超えて設定できない", async () => {
    await expect(
      asServiceRole(db, "select public.claim_line_webhook_event('x','message',false,null, interval '2 minutes')"),
    ).rejects.toThrow(/reply window/);
  });
});

describe("begin_line_reply / record_line_reply_result（返信トークンは 1 回のみ）", () => {
  it("期限内の初回だけ true、2 回目以降は false", async () => {
    await claim("ev1");
    expect(await beginReply("ev1")).toBe(true);
    expect(await beginReply("ev1")).toBe(false);
    expect((await row("ev1")).reply_status).toBe("sending");
  });

  it("並列に返信予約しても true は 1 回だけ", async () => {
    await claim("ev1");
    const results = await Promise.all(Array.from({ length: 5 }, () => beginReply("ev1")));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("返信期限を過ぎていたら false（期限切れトークンを使わない）", async () => {
    await claim("ev1");
    await db.query(
      "update public.line_webhook_events set reply_deadline_at = now() - interval '1 second' where webhook_event_id='ev1'",
    );
    expect(await beginReply("ev1")).toBe(false);
  });

  it("未登録のイベントは false", async () => {
    expect(await beginReply("nope")).toBe(false);
  });

  it("結果は sending からのみ記録でき、成否不明（unknown）も区別できる", async () => {
    await claim("ev1");
    expect(await recordReply("ev1", "sent")).toBe(false); // まだ sending でない
    await beginReply("ev1");
    expect(await recordReply("ev1", "unknown")).toBe(true);
    expect(await recordReply("ev1", "sent")).toBe(false); // 一度決まった結果は変えない
    expect((await row("ev1")).reply_status).toBe("unknown");
    // unknown のあとも再び返信予約はできない（二重送信しない）
    expect(await beginReply("ev1")).toBe(false);
  });

  it("dry-run の結果は simulated として記録でき、sent とは区別される。以後は返信予約できない", async () => {
    await claim("ev1");
    await beginReply("ev1");
    expect(await recordReply("ev1", "simulated")).toBe(true);
    expect(await recordReply("ev1", "sent")).toBe(false); // 送信成功に書き換えられない
    expect((await row("ev1")).reply_status).toBe("simulated");
    expect(await beginReply("ev1")).toBe(false);
    expect(await finish("ev1", "done")).toBe(true);
    expect((await row("ev1")).reply_status).toBe("simulated");
  });

  it("reply_status の制約は simulated を許可し、それ以外の未知の値は拒否する", async () => {
    await claim("ev1");
    await expect(
      db.exec("update public.line_webhook_events set reply_status = 'dry_run', reply_attempted_at = now() where webhook_event_id = 'ev1'"),
    ).rejects.toThrow(/line_webhook_events_reply_status_check/);
    await db.exec(
      "update public.line_webhook_events set reply_status = 'simulated', reply_attempted_at = now() where webhook_event_id = 'ev1'",
    );
    expect((await row("ev1")).reply_status).toBe("simulated");
  });

  it("不正な結果値は拒否", async () => {
    await expect(recordReply("ev1", "maybe")).rejects.toThrow(/invalid reply result/);
  });
});

describe("finish_line_webhook_event（処理状況の記録）", () => {
  it("成功を記録する", async () => {
    await claim("ev1");
    await beginReply("ev1");
    await recordReply("ev1", "sent");
    expect(await finish("ev1", "done")).toBe(true);
    const r = await row("ev1");
    expect(r.status).toBe("done");
    expect(r.processed_at).not.toBeNull();
  });

  it("失敗をエラー概要・要通知フラグ付きで記録する（エラーは 300 文字まで）", async () => {
    await claim("ev1");
    expect(await finish("ev1", "failed", "x".repeat(500), true)).toBe(true);
    const r = await row("ev1");
    expect(r.status).toBe("failed");
    expect(r.needs_owner_notification).toBe(true);
    expect((r.last_error as string).length).toBe(300);
  });

  it("送信中のまま終了したら reply_status は unknown になる", async () => {
    await claim("ev1");
    await beginReply("ev1");
    await finish("ev1", "failed");
    expect((await row("ev1")).reply_status).toBe("unknown");
  });

  it("終了済みのイベントは再度終了できない", async () => {
    await claim("ev1");
    await finish("ev1", "done");
    expect(await finish("ev1", "failed")).toBe(false);
    expect((await row("ev1")).status).toBe("done");
  });

  it("終了後は返信予約できない", async () => {
    await claim("ev1");
    await finish("ev1", "skipped");
    expect(await beginReply("ev1")).toBe(false);
  });
});

describe("mark_stalled_line_webhook_events（途中停止の検出）", () => {
  const ageEvent = (id: string, minutes: number) =>
    db.query(
      `update public.line_webhook_events
          set processing_started_at = now() - make_interval(mins => $2),
              received_at = now() - make_interval(mins => $2)
        where webhook_event_id = $1`,
      [id, minutes],
    );

  it("一定時間 processing のままのイベントだけを abandoned・要通知にする", async () => {
    await claim("stalled");
    await claim("stalled-sending");
    await beginReply("stalled-sending");
    await claim("fresh");
    await claim("finished");
    await finish("finished", "done");
    await ageEvent("stalled", 10);
    await ageEvent("stalled-sending", 10);
    await ageEvent("finished", 10);

    const res = await asServiceRole<{ webhook_event_id: string; reply_status: string }>(
      db,
      "select * from public.mark_stalled_line_webhook_events(interval '5 minutes') order by webhook_event_id",
    );
    expect(res.rows.map((r) => [r.webhook_event_id, r.reply_status])).toEqual([
      ["stalled", "none"],
      ["stalled-sending", "unknown"], // 成否不明。再送しない
    ]);
    expect((await row("stalled")).status).toBe("abandoned");
    expect((await row("stalled")).needs_owner_notification).toBe(true);
    expect((await row("fresh")).status).toBe("processing");
    expect((await row("finished")).status).toBe("done");
    // 停止扱いにしたイベントは、その後の終了・返信予約もできない
    expect(await finish("stalled", "done")).toBe(false);
    expect(await beginReply("stalled")).toBe(false);
  });

  it("2 分未満の閾値は拒否（処理中のイベントを誤って打ち切らない）", async () => {
    await expect(
      asServiceRole(db, "select * from public.mark_stalled_line_webhook_events(interval '30 seconds')"),
    ).rejects.toThrow(/at least 2 minutes/);
  });
});

describe("権限", () => {
  it.each([
    ["claim_line_webhook_event", "select public.claim_line_webhook_event('a','message',false)"],
    ["begin_line_reply", "select public.begin_line_reply('a')"],
    ["record_line_reply_result", "select public.record_line_reply_result('a','sent')"],
    ["finish_line_webhook_event", "select public.finish_line_webhook_event('a','done')"],
    ["mark_stalled_line_webhook_events", "select * from public.mark_stalled_line_webhook_events()"],
  ])("%s は authenticated・anon から実行できない", async (_name, sql) => {
    for (const role of ["authenticated", "anon"]) {
      await db.exec(`set role ${role}`);
      await expect(db.query(sql)).rejects.toThrow(/permission denied/);
      await db.exec("reset role");
    }
  });

  it("保持期間の削除で 7 日を過ぎたイベント記録が消える", async () => {
    await claim("old");
    await claim("new");
    await db.query("update public.line_webhook_events set received_at = now() - interval '8 days' where webhook_event_id='old'");
    const r = await db.query<{ deleted_events: number }>("select deleted_events from private.purge_expired_data()");
    expect(Number(r.rows[0].deleted_events)).toBe(1);
  });
});
