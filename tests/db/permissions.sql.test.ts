import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDbWithMigrations, createMigratedDb, migrationFiles } from "./pglite";

// PGlite の DB を作り直すテストがあり、PC の負荷が高いと既定の 5 秒を超えることがあるため延ばす
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * ロールごとの実際の操作で権限と RLS を確認する（PGlite・実 Supabase には接続しない）。
 * PGlite の既定権限は実プロジェクトで確認した値に合わせている（tests/db/pglite.ts）。
 */
const ADMIN = "11111111-1111-1111-1111-111111111111";
const NON_ADMIN = "22222222-2222-2222-2222-222222222222";
const LINE_USER = `U${"a".repeat(32)}`;
const DENIED = /permission denied/;
const RLS_DENIED = /row-level security/;

type Role = "anon" | "authenticated" | "service_role";

/** 指定ロール（authenticated は sub 付き）で SQL を実行する */
async function as(db: PGlite, role: Role, sql: string, sub?: string) {
  await db.exec(`set request.jwt.claim.sub = '${sub ?? ""}'`);
  await db.exec(`set role ${role}`);
  try {
    return await db.query<Record<string, unknown>>(sql);
  } finally {
    await db.exec("reset role; reset request.jwt.claim.sub");
  }
}

/** 管理者・非管理者・FAQ・テスト送信済みの配信を用意する（postgres として） */
async function seed(db: PGlite) {
  await db.exec(`
    insert into auth.users (id) values ('${ADMIN}'), ('${NON_ADMIN}');
    insert into public.admin_users (user_id, display_name) values ('${ADMIN}', 'owner');
    insert into public.faqs (question, answer) values ('営業時間は？', '10時〜19時です');
    insert into public.menus (name, price) values ('カット', 4400);
    insert into public.broadcasts (id, body) values ('33333333-3333-3333-3333-333333333333', 'お知らせ');
    update public.broadcasts set status = 'tested', tested_at = now() where id = '33333333-3333-3333-3333-333333333333';
  `);
}

describe("3 本目（grant_service_role）がない場合", () => {
  it("service_role は Webhook の受付記録（claim）が permission denied になる", async () => {
    const db = await createDbWithMigrations(migrationFiles().filter((f) => !f.includes("grant_service_role")));
    await expect(
      as(db, "service_role", "select public.claim_line_webhook_event('ev1', 'message', false)"),
    ).rejects.toThrow(DENIED);
    await expect(as(db, "service_role", "select * from public.shop_settings")).rejects.toThrow(DENIED);
  });
});

describe("3 本適用後の権限", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createMigratedDb();
    await seed(db);
  });

  describe("service_role（サーバー処理）に必要な操作は成功する", () => {
    it("Webhook イベントの一連の処理（受付→返信予約→結果記録→終了→停止検出）", async () => {
      const q = (sql: string) => as(db, "service_role", sql);
      expect((await q("select public.claim_line_webhook_event('ev-ok', 'message', false) as r")).rows[0].r).toBe(true);
      expect((await q("select public.claim_line_webhook_event('ev-ok', 'message', true) as r")).rows[0].r).toBe(false);
      expect((await q("select public.begin_line_reply('ev-ok') as r")).rows[0].r).toBe(true);
      expect((await q("select public.record_line_reply_result('ev-ok', 'sent') as r")).rows[0].r).toBe(true);
      expect((await q("select public.finish_line_webhook_event('ev-ok', 'done') as r")).rows[0].r).toBe(true);
      expect((await q("select * from public.mark_stalled_line_webhook_events()")).rows).toEqual([]);
      // オーナー通知後の記録（WBS 2.5 で使用）
      await q("update public.line_webhook_events set needs_owner_notification = true, owner_notified_at = now() where webhook_event_id = 'ev-ok'");
    });

    it("応答の根拠（店舗情報・FAQ・メニュー）を読める", async () => {
      expect((await as(db, "service_role", "select bot_enabled from public.shop_settings")).rows).toHaveLength(1);
      expect((await as(db, "service_role", "select * from public.faqs")).rows).toHaveLength(1);
      expect((await as(db, "service_role", "select * from public.menus")).rows).toHaveLength(1);
    });

    it("会話ログを冪等に保存・通知済みを記録・一覧できる", async () => {
      const insert = `insert into public.conversations (line_event_id, line_user_id, message_type, ai_status)
                      values ('ev-c', '${LINE_USER}', 'text', 'answered')
                      on conflict (line_event_id) do nothing returning id`;
      expect((await as(db, "service_role", insert)).rows).toHaveLength(1);
      expect((await as(db, "service_role", insert)).rows).toHaveLength(0);
      await as(db, "service_role", "update public.conversations set owner_notified_at = now() where line_event_id = 'ev-c'");
      expect((await as(db, "service_role", "select * from public.conversations where needs_owner and resolved_at is null")).rows).toEqual([]);
    });

    it("配信の送信権を取得できる（start_broadcast_sending）", async () => {
      const r = await as(
        db,
        "service_role",
        "select status from public.start_broadcast_sending('33333333-3333-3333-3333-333333333333', 300, 1000)",
      );
      expect(r.rows[0].status).toBe("sending");
      await as(db, "service_role", "update public.broadcasts set status = 'sent', sent_at = now() where status = 'sending'");
    });

    it("保持期間の削除（purge_expired_data・security definer）を実行できる", async () => {
      const r = await as(db, "service_role", "select * from private.purge_expired_data()");
      expect(r.rows).toHaveLength(1);
    });
  });

  describe("service_role でも不要な操作はできない", () => {
    it.each([
      ["イベント記録の削除", "delete from public.line_webhook_events"],
      ["会話ログの削除", "delete from public.conversations"],
      ["TRUNCATE", "truncate public.faqs"],
      ["FAQ の追加", "insert into public.faqs (question, answer) values ('q', 'a')"],
      ["店舗情報の更新", "update public.shop_settings set bot_enabled = true"],
      ["メニューの更新", "update public.menus set price = 1"],
      ["配信の作成", "insert into public.broadcasts (body) values ('x')"],
      ["管理者の参照", "select * from public.admin_users"],
    ])("%s → permission denied", async (_l, sql) => {
      await expect(as(db, "service_role", sql)).rejects.toThrow(DENIED);
    });
  });

  describe("anon（未ログイン）は何もできない", () => {
    it.each([
      ["FAQ の参照", "select * from public.faqs"],
      ["店舗情報の参照", "select * from public.shop_settings"],
      ["イベント記録の追加", "insert into public.line_webhook_events (webhook_event_id, event_type) values ('x', 'message')"],
      ["TRUNCATE", "truncate public.menus"],
      ["受付関数の実行", "select public.claim_line_webhook_event('x', 'message', false)"],
      ["配信関数の実行", "select public.start_broadcast_sending('33333333-3333-3333-3333-333333333333', 1, 1)"],
      ["削除関数の実行", "select private.purge_expired_data()"],
    ])("%s → permission denied", async (_l, sql) => {
      await expect(as(db, "anon", sql)).rejects.toThrow(DENIED);
    });
  });

  describe("authenticated（管理画面）", () => {
    it("管理者ではないユーザーは RLS で何も見えず、追加もできない", async () => {
      expect((await as(db, "authenticated", "select * from public.faqs", NON_ADMIN)).rows).toEqual([]);
      expect((await as(db, "authenticated", "select * from public.shop_settings", NON_ADMIN)).rows).toEqual([]);
      await expect(
        as(db, "authenticated", "insert into public.faqs (question, answer) values ('q', 'a')", NON_ADMIN),
      ).rejects.toThrow(RLS_DENIED);
    });

    it("管理者は FAQ の追加・店舗情報の更新ができる", async () => {
      expect((await as(db, "authenticated", "select * from public.faqs", ADMIN)).rows.length).toBeGreaterThan(0);
      await as(db, "authenticated", "insert into public.faqs (question, answer) values ('駐車場は？', '2台あります')", ADMIN);
      await as(db, "authenticated", "update public.shop_settings set temporary_notice = '臨時休業のお知らせ'", ADMIN);
    });

    it.each([
      ["イベント記録の参照", "select * from public.line_webhook_events"],
      ["会話ログの追加", `insert into public.conversations (line_event_id, line_user_id, message_type, ai_status) values ('x', '${LINE_USER}', 'text', 'answered')`],
      ["会話ログの本文の改ざん", "update public.conversations set bot_reply = 'x'"],
      ["店舗情報の id の変更", "update public.shop_settings set id = 1"],
      ["配信状態の直接変更", "update public.broadcasts set status = 'sending'"],
      ["管理者の追加", `insert into public.admin_users (user_id) values ('${NON_ADMIN}')`],
      ["TRUNCATE", "truncate public.faqs"],
      ["受付関数の実行", "select public.begin_line_reply('ev-ok')"],
      ["配信関数の実行", "select public.start_broadcast_sending('33333333-3333-3333-3333-333333333333', 1, 1)"],
      ["削除関数の実行", "select private.purge_expired_data()"],
    ])("管理者でも %s → permission denied", async (_l, sql) => {
      await expect(as(db, "authenticated", sql, ADMIN)).rejects.toThrow(DENIED);
    });
  });

  it("全テーブルで RLS が有効なまま", async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'",
    );
    // 7 テーブル＋6 本目の ai_usage_reservations＋7 本目の owner_notification_batches
    expect(r.rows).toHaveLength(9);
    expect(r.rows.every((x) => x.relrowsecurity)).toBe(true);
  });
});
