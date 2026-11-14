import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { createDbWithMigrations, createMigratedDb, createSupabaseStubDb, migrationFiles } from "./pglite";

// PGlite の DB を作り直すテストが多く、PC の負荷が高いと既定の 5 秒を超えることがあるため延ばす
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * 本番 Supabase で実行する確認用 SQL（scripts/supabase/*.sql）が、
 * 期待どおりに OK / NG を判定できることを PGlite 上で確かめる。
 */
const read = (name: string) => readFileSync(join(process.cwd(), "scripts", "supabase", name), "utf8");
type Row = { item: string; result: "OK" | "NG" | "要確認"; detail: string; category?: string };

async function run(db: PGlite, file: string): Promise<Row[]> {
  // 本番と同じく読み取り専用トランザクションで実行し、データを変更しないことも確認する
  await db.exec("begin read only");
  try {
    return (await db.query<Row>(read(file))).rows;
  } finally {
    await db.exec("rollback");
  }
}
const notOk = (rows: Row[]) => rows.filter((r) => r.result !== "OK");

describe("適用前チェック（preflight.sql）", () => {
  it("新規プロジェクト相当の DB では NG なし。既定権限の不足は「要確認」として実際の値を表示する", async () => {
    const rows = await run(await createSupabaseStubDb(), "preflight.sql");
    expect(rows.length).toBeGreaterThan(10);
    expect(notOk(rows)).toEqual([
      expect.objectContaining({
        item: "既定権限：新規テーブルに service_role の SELECT/INSERT/UPDATE/DELETE が付く",
        result: "要確認",
        detail: expect.stringMatching(/^既定: MAINTAIN,REFERENCES,TRIGGER,TRUNCATE → .*20261110020000_grant_service_role\.sql/),
      }),
    ]);
  });

  it("既定権限が十分な環境（以前の Supabase の既定）なら全項目 OK", async () => {
    const db = await createSupabaseStubDb();
    await db.exec("alter default privileges for role postgres in schema public grant all on tables to service_role");
    expect(notOk(await run(db, "preflight.sql"))).toEqual([]);
  });

  it("適用済み（または別プロジェクト）の DB では NG を出す", async () => {
    const ng = notOk(await run(await createMigratedDb(), "preflight.sql")).map((r) => r.item);
    expect(ng).toContain("private スキーマがまだない");
    expect(ng).toContain("本システムのテーブルがまだない（7 テーブル）");
    expect(ng).toContain("public スキーマにテーブル・ビューが 1 つもない（新規プロジェクトである）");
  });

});

describe("適用後チェック（verify.sql）", () => {
  it(`マイグレーション ${migrationFiles().length} 本を適用した DB では全項目 OK`, async () => {
    const rows = await run(await createMigratedDb(), "verify.sql");
    expect(rows.length).toBeGreaterThan(60);
    expect(notOk(rows)).toEqual([]);
  });

  it("3 本目（service_role への GRANT）がないと、service_role の全テーブルが NG", async () => {
    const db = await createDbWithMigrations(migrationFiles().filter((f) => !f.includes("grant_service_role")));
    const ng = notOk(await run(db, "verify.sql")).filter((r) => r.category?.startsWith("5 "));
    // 6 テーブルは必要な権限が不足、admin_users は既定の TRUNCATE 等が残っているため、7 テーブルすべて NG
    expect(ng.map((r) => r.item).sort()).toEqual(
      ["admin_users", "broadcasts", "conversations", "faqs", "line_webhook_events", "menus", "shop_settings"].sort(),
    );
  });

  it("5 本目（conversations の根拠列）がないと NG", async () => {
    const db = await createDbWithMigrations(migrationFiles().filter((f) => !f.includes("conversation_ai_sources")));
    const ng = notOk(await run(db, "verify.sql")).map((r) => r.item);
    expect(ng).toEqual(["conversations に AI 回答の根拠の列（5 本目のマイグレーション）"]);
  });

  it("7 本目（オーナー通知）がないと、追加したテーブル・関数・確認項目だけが NG", async () => {
    const db = await createDbWithMigrations(migrationFiles().filter((f) => !f.includes("owner_notifications")));
    const rows = await run(db, "verify.sql");
    const ng = notOk(rows).map((r) => r.item);
    expect(new Set(ng)).toEqual(
      new Set([
        "owner_notification_batches",
        "public.claim_owner_notification_batch(boolean,integer,integer,integer)",
        "public.finish_owner_notification_batch(uuid,text,text)",
        "ユーザー ID・本文を保存しない列構成（7 本目のマイグレーション）",
        "再送キーは一意・まとめの確保はロックで直列化",
      ]),
    );
    // 7 本目を適用した DB では、この 6 本目までの DB より 2 項目（関数 2 つの search_path）多い
    const all = await run(await createMigratedDb(), "verify.sql");
    expect(all.length - rows.length).toBe(2);
  });

  it("8 本目（保持期間の削除の入口）がないと、追加した関数と確認項目だけが NG", async () => {
    const db = await createDbWithMigrations(migrationFiles().filter((f) => !f.includes("retention_purge")));
    const ng = notOk(await run(db, "verify.sql")).map((r) => r.item);
    expect(new Set(ng)).toEqual(
      new Set([
        "public.run_retention_purge()",
        "削除の入口は引数なし・保持期間固定・重複実行は busy（8 本目のマイグレーション）",
      ]),
    );
  });

  it("4 本目（reply_status = simulated）がないと NG", async () => {
    const db = await createDbWithMigrations(migrationFiles().filter((f) => !f.includes("reply_status_simulated")));
    const ng = notOk(await run(db, "verify.sql")).map((r) => r.item);
    expect(ng).toEqual(["reply_status に simulated（dry-run）を許可（4 本目のマイグレーション）"]);
  });

  it.each([
    ["RLS の無効化", "alter table public.faqs disable row level security", "faqs"],
    ["anon への権限付与", "grant select on public.menus to anon", "menus"],
    ["関数を authenticated に開放", "grant execute on function public.begin_line_reply(text) to authenticated", "public.begin_line_reply(text)"],
    ["列権限の付与し過ぎ", "grant update (status) on public.broadcasts to authenticated", "broadcasts.status UPDATE"],
    ["service_role の権限不足", "revoke insert on public.conversations from service_role", "conversations"],
    ["service_role の付け過ぎ（DELETE）", "grant delete on public.line_webhook_events to service_role", "line_webhook_events"],
    ["service_role の付け過ぎ（TRUNCATE）", "grant truncate on public.faqs to service_role", "faqs"],
    ["authenticated の付け過ぎ（MAINTAIN）", "grant maintain on public.menus to authenticated", "menus"],
    ["ポリシーの削除", "drop policy broadcasts_delete on public.broadcasts", "broadcasts"],
    ["2 本目の未適用相当（制約なし）", "alter table public.line_webhook_events drop constraint line_webhook_events_reply_status_check", "line_webhook_events_reply_status_check"],
    ["自動応答が ON", "update public.shop_settings set bot_enabled = true", "shop_settings は 1 行・自動応答は OFF"],
  ])("%s を検出する", async (_label, sabotage, item) => {
    const db = await createMigratedDb();
    await db.exec(sabotage);
    const ng = notOk(await run(db, "verify.sql"));
    expect(ng.map((r) => r.item)).toContain(item);
  });
});

describe("デプロイ前後の比較（deploy-snapshot.sql）", () => {
  it("読み取り専用で 13 項目を返し、本文・LINE ユーザー ID を含まない。データを変えると値が変わる", async () => {
    const db = await createMigratedDb();
    const user = `U${"a".repeat(32)}`;
    await db.query(
      `insert into public.conversations (line_event_id, line_user_id, message_type, user_message, ai_status)
       values ('01SNAP', $1, 'text', '本文のテスト', 'answered')`,
      [user],
    );
    const snap = async () => {
      await db.exec("begin read only");
      try {
        return (await db.query<{ item: string; value: string }>(read("deploy-snapshot.sql"))).rows;
      } finally {
        await db.exec("rollback");
      }
    };
    const before = await snap();
    expect(before).toHaveLength(13);
    expect(JSON.stringify(before)).not.toContain(user);
    expect(JSON.stringify(before)).not.toContain("本文のテスト");
    expect(before[0]).toEqual({ item: "shop_settings：自動応答（bot_enabled）", value: "false" });
    expect(await snap()).toEqual(before);
    await db.query("update public.conversations set resolved_at = now()");
    expect(await snap()).not.toEqual(before);
  });
});
