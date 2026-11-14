import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedDb } from "./pglite";

/**
 * 管理画面（src/lib/admin/repo.ts）が行う操作を、ログイン中の管理者（authenticated ロール＋JWT の sub）として
 * PGlite 上で実行し、RLS・列単位の権限・トリガーで期待どおりに許可／拒否されることを確かめる。
 * 実際の Supabase には接続しない。
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ADMIN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NON_ADMIN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER_LINE = `U${"d".repeat(32)}`;
const CUSTOMER = `U${"e".repeat(32)}`;
const DENIED = /permission denied|row-level security/;

let db: PGlite;

/**
 * 指定ユーザー（authenticated）として 1 文を実行する。
 * テストごとのトランザクションの中で、文ごとにセーブポイントを置く（拒否されても後続の文を実行できるように）。
 */
async function as(sub: string, sql: string, params: unknown[] = []) {
  await db.exec("savepoint stmt");
  await db.exec(`set local request.jwt.claim.sub = '${sub}'`);
  await db.exec("set local role authenticated");
  try {
    const r = await db.query<Record<string, unknown>>(sql, params);
    await db.exec("reset role; release savepoint stmt");
    return r;
  } catch (e) {
    await db.exec("rollback to savepoint stmt; reset role");
    throw e;
  }
}

// DB はファイル全体で 1 回だけ作り、各テストはトランザクションの中で実行して最後に取り消す（PC の負荷を減らす）
beforeAll(async () => {
  db = await createMigratedDb();
  await db.exec(`
    insert into auth.users (id) values ('${ADMIN}'), ('${OTHER_ADMIN}'), ('${NON_ADMIN}');
    insert into public.admin_users (user_id, display_name) values ('${ADMIN}', 'owner'), ('${OTHER_ADMIN}', 'staff');
  `);
});
beforeEach(async () => {
  await db.exec("begin");
});
afterEach(async () => {
  await db.exec("rollback");
});

describe("ログイン・管理者の判定（admin_users）", () => {
  it("管理者は自分の行を読める。管理者でないユーザーは 0 件（resolveAdmin は forbidden）", async () => {
    expect((await as(ADMIN, `select user_id from public.admin_users where user_id = '${ADMIN}'`)).rows).toHaveLength(1);
    expect((await as(NON_ADMIN, `select user_id from public.admin_users where user_id = '${NON_ADMIN}'`)).rows).toHaveLength(0);
  });

  it("管理者でないユーザーは、FAQ・店舗情報・会話ログを読めず、変更もできない", async () => {
    await db.exec("insert into public.faqs (question, answer) values ('q', 'a')");
    expect((await as(NON_ADMIN, "select * from public.faqs")).rows).toHaveLength(0);
    expect((await as(NON_ADMIN, "select * from public.shop_settings")).rows).toHaveLength(0);
    expect((await as(NON_ADMIN, "update public.shop_settings set bot_enabled = true where id = 1 returning id")).rows).toHaveLength(0);
    await expect(as(NON_ADMIN, "insert into public.faqs (question, answer) values ('x', 'y')")).rejects.toThrow(DENIED);
  });
});

describe("FAQ・メニュー（バッチ 2）", () => {
  it("管理者は追加・編集・公開切り替え・削除ができる", async () => {
    const ins = await as(ADMIN, "insert into public.faqs (question, answer, category, is_published, sort_order) values ('駐車場は？', 'あります', 'access', true, 1) returning id");
    const id = ins.rows[0].id as string;
    expect((await as(ADMIN, "update public.faqs set answer = '2台あります' where id = $1 returning id", [id])).rows).toHaveLength(1);
    expect((await as(ADMIN, "update public.faqs set is_published = false where id = $1 returning id", [id])).rows).toHaveLength(1);
    expect((await as(ADMIN, "delete from public.faqs where id = $1 returning id", [id])).rows).toHaveLength(1);

    const m = await as(ADMIN, "insert into public.menus (name, category, price, price_note, duration_min, description, is_published, sort_order) values ('カット', 'cut', 4400, '', 60, '', true, 0) returning id");
    expect((await as(ADMIN, "update public.menus set price = 4950 where id = $1 returning price", [m.rows[0].id])).rows[0].price).toBe(4950);
  });

  it.each([
    ["FAQ の質問が 301 文字", "insert into public.faqs (question, answer) values (repeat('あ', 301), 'a')"],
    ["FAQ の分類が不正", "insert into public.faqs (question, answer, category) values ('q', 'a', 'xxx')"],
    ["料金が負", "insert into public.menus (name, price) values ('x', -1)"],
    ["料金が上限超え", "insert into public.menus (name, price) values ('x', 1000001)"],
    ["所要時間 0 分", "insert into public.menus (name, price, duration_min) values ('x', 1, 0)"],
  ])("DB の制約でも拒否される（画面の入力チェックと同じ条件）：%s", async (_l, sql) => {
    await expect(as(ADMIN, sql)).rejects.toThrow(/check constraint|violates/);
  });
});

describe("店舗情報・自動応答 ON/OFF・通知先（バッチ 2）", () => {
  it("管理者は店舗情報・自動応答・通知先を更新できる", async () => {
    const r = await as(
      ADMIN,
      `update public.shop_settings set shop_name = '架空サロン', phone = '03-0000-0000', fallback_message = '確認します',
         bot_enabled = true, owner_line_user_id = '${OWNER_LINE}' where id = 1 returning bot_enabled`,
    );
    expect(r.rows[0].bot_enabled).toBe(true);
    expect((await as(ADMIN, "update public.shop_settings set owner_line_user_id = null where id = 1 returning id")).rows).toHaveLength(1);
  });

  it("通知先の形式が不正なら DB でも拒否される", async () => {
    await expect(as(ADMIN, "update public.shop_settings set owner_line_user_id = 'U123' where id = 1")).rejects.toThrow(/check constraint/);
  });

  it("管理者でも id・更新日時は変更できない（列単位の権限）", async () => {
    await expect(as(ADMIN, "update public.shop_settings set id = 2 where id = 1")).rejects.toThrow(DENIED);
    await expect(as(ADMIN, "update public.shop_settings set updated_at = now() where id = 1")).rejects.toThrow(DENIED);
  });
});

describe("会話ログ・対応済み（バッチ 3）", () => {
  async function seedConversation(needsOwner = true) {
    const r = await db.query<{ id: string }>(
      `insert into public.conversations (line_event_id, line_user_id, message_type, user_message, ai_status, needs_owner)
       values (gen_random_uuid()::text, $1, 'text', 'シャンプーはありますか', 'cannot_answer', $2) returning id`,
      [CUSTOMER, needsOwner],
    );
    return r.rows[0].id;
  }

  it("管理者は会話ログを読め、自分の名前で対応済みにできる（未対応のものだけ・1 回だけ）", async () => {
    const id = await seedConversation();
    expect((await as(ADMIN, "select id from public.conversations where needs_owner and resolved_at is null")).rows).toHaveLength(1);
    const sql = `update public.conversations set resolved_at = now(), resolved_by = '${ADMIN}'
                 where id = $1 and needs_owner and resolved_at is null returning id`;
    expect((await as(ADMIN, sql, [id])).rows).toHaveLength(1);
    // 二重に押しても更新されない
    expect((await as(ADMIN, sql, [id])).rows).toHaveLength(0);
  });

  it("他の管理者の名前では対応済みにできない（RLS）", async () => {
    const id = await seedConversation();
    await expect(
      as(ADMIN, `update public.conversations set resolved_at = now(), resolved_by = '${OTHER_ADMIN}' where id = $1`, [id]),
    ).rejects.toThrow(DENIED);
  });

  it("会話ログの本文・要対応フラグ・通知日時は変更できない（改ざん防止）", async () => {
    const id = await seedConversation();
    await expect(as(ADMIN, "update public.conversations set user_message = 'x' where id = $1", [id])).rejects.toThrow(DENIED);
    await expect(as(ADMIN, "update public.conversations set needs_owner = false where id = $1", [id])).rejects.toThrow(DENIED);
    await expect(as(ADMIN, "update public.conversations set owner_notified_at = now() where id = $1", [id])).rejects.toThrow(DENIED);
    await expect(as(ADMIN, "delete from public.conversations where id = $1", [id])).rejects.toThrow(DENIED);
  });
});

describe("一斉配信（バッチ 4）", () => {
  it("管理者は下書きを作成・本文を編集・削除できる（状態は draft から始まる）", async () => {
    const r = await as(ADMIN, "insert into public.broadcasts (body) values ('臨時休業のお知らせ') returning id, status, created_by");
    expect(r.rows[0]).toMatchObject({ status: "draft", created_by: ADMIN });
    const id = r.rows[0].id;
    expect((await as(ADMIN, "update public.broadcasts set body = '修正' where id = $1 and status in ('draft','tested','failed') returning id", [id])).rows).toHaveLength(1);
    expect((await as(ADMIN, "delete from public.broadcasts where id = $1 and status in ('draft','tested') returning id", [id])).rows).toHaveLength(1);
  });

  it("管理者でも状態・テスト送信日時・再送キーは変更できない（サーバーだけが変更する）", async () => {
    const id = (await as(ADMIN, "insert into public.broadcasts (body) values ('x') returning id")).rows[0].id;
    await expect(as(ADMIN, "update public.broadcasts set status = 'tested' where id = $1", [id])).rejects.toThrow(DENIED);
    await expect(as(ADMIN, "update public.broadcasts set tested_at = now() where id = $1", [id])).rejects.toThrow(DENIED);
    await expect(as(ADMIN, "insert into public.broadcasts (body, status) values ('x', 'sending')")).rejects.toThrow(DENIED);
  });

  /** サーバー（service_role）として 1 文を実行する（src/lib/db/broadcasts.ts の状態変更と同じ SQL） */
  async function asServer(sql: string, params: unknown[] = []) {
    await db.exec("savepoint stmt");
    await db.exec("set local role service_role");
    try {
      const r = await db.query<Record<string, unknown>>(sql, params);
      await db.exec("reset role; release savepoint stmt");
      return r;
    } catch (e) {
      await db.exec("rollback to savepoint stmt; reset role");
      throw e;
    }
  }

  it("サーバーの状態変更：テスト送信済み → 送信権の取得（1 件だけ）→ 送信済み。再送キーは変わらない", async () => {
    const id = (await as(ADMIN, "insert into public.broadcasts (body) values ('お知らせ') returning id")).rows[0].id as string;
    const key = (await db.query<{ k: string }>("select retry_key::text as k from public.broadcasts where id = $1", [id])).rows[0].k;
    expect((await asServer("update public.broadcasts set status = 'tested', tested_at = now() where id = $1 and status in ('draft','tested') returning id", [id])).rows).toHaveLength(1);

    const started = await asServer("select (public.start_broadcast_sending($1, 3, 190)).status as s", [id]);
    expect(started.rows[0].s).toBe("sending");
    // 連打：2 回目の送信権は取れない
    await expect(asServer("select public.start_broadcast_sending($1, 3, 190)", [id])).rejects.toThrow(/not ready/);
    // 別の配信も同時には送信中にできない（送信中は 1 件だけ）
    const other = (await as(ADMIN, "insert into public.broadcasts (body) values ('別') returning id")).rows[0].id as string;
    await asServer("update public.broadcasts set status = 'tested', tested_at = now() where id = $1", [other]);
    await expect(asServer("select public.start_broadcast_sending($1, 3, 190)", [other])).rejects.toThrow(/duplicate key|unique/);

    expect((await asServer("update public.broadcasts set status = 'sent', sent_at = now(), error_message = null where id = $1 and status = 'sending' returning retry_key::text as k", [id])).rows[0].k).toBe(key);
  });

  it("成否不明（failed）からの再送でも再送キーは変わらない。送信可能数が足りなければ送信権を取れない", async () => {
    const id = (await as(ADMIN, "insert into public.broadcasts (body) values ('お知らせ') returning id")).rows[0].id as string;
    await asServer("update public.broadcasts set status = 'tested', tested_at = now() where id = $1", [id]);
    await expect(asServer("select public.start_broadcast_sending($1, 10, 5)", [id])).rejects.toThrow(/insufficient quota/);
    await asServer("select public.start_broadcast_sending($1, 3, 190)", [id]);
    const before = (await db.query<{ k: string }>("select retry_key::text as k from public.broadcasts where id = $1", [id])).rows[0].k;
    await asServer("update public.broadcasts set status = 'failed', error_message = 'broadcast_result_unknown' where id = $1 and status = 'sending'", [id]);
    const again = await asServer("select (public.start_broadcast_sending($1, 3, 190)).retry_key::text as k", [id]);
    expect(again.rows[0].k).toBe(before);
  });

  it("送信中・送信済みの配信は削除できず、本文も変更できない", async () => {
    await db.exec(`
      insert into public.broadcasts (id, body) values ('99999999-9999-4999-8999-999999999999', 'x');
      update public.broadcasts set status = 'tested', tested_at = now() where id = '99999999-9999-4999-8999-999999999999';
      update public.broadcasts set status = 'sending', sending_started_at = now() where id = '99999999-9999-4999-8999-999999999999';
    `);
    const id = "99999999-9999-4999-8999-999999999999";
    expect((await as(ADMIN, "delete from public.broadcasts where id = $1 returning id", [id])).rows).toHaveLength(0);
    // RLS（broadcasts_update）で送信中の行は更新の対象外になり、0 件の更新になる
    expect((await as(ADMIN, "update public.broadcasts set body = 'y' where id = $1 returning id", [id])).rows).toHaveLength(0);
    expect((await db.query<{ body: string }>("select body from public.broadcasts where id = $1", [id])).rows[0].body).toBe("x");
  });
});
