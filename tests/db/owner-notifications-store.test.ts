import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DbError } from "@/lib/db/errors";
import { parseClaimResult, SupabaseOwnerNotificationStore } from "@/lib/db/owner-notifications";
import { LineApiError, type LinePushClient } from "@/lib/line/client";
import { createOwnerNotifier } from "@/lib/notify/owner-notifier";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import { silentLogger } from "../line/fixtures";
import { createMigratedDb } from "./pglite";
import { pgliteRpcClient } from "./rpc-adapter";

/**
 * オーナー通知の DB アクセス（SupabaseOwnerNotificationStore）と通知処理を、PGlite 上の 7 本目の関数と組み合わせて確認する。
 * LINE への push はモック。実際の Supabase・LINE には接続しない。
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const OWNER = `U${"e".repeat(32)}`;
const CUSTOMER = `U${"f".repeat(32)}`;
let db: PGlite;
let seq = 0;

/** rpc（PGlite の関数）と、詳細取得に使う from().select().in() だけを再現するテスト用クライアント */
function client(d: PGlite): ServerSupabaseClient {
  const rpc = pgliteRpcClient(d) as unknown as { rpc: unknown };
  const from = (table: string) => ({
    select: (cols: string) => ({
      in: async (col: string, values: string[]) => {
        if (!/^[a-z_]+$/.test(table) || !/^[a-z_, ]+$/.test(cols) || !/^[a-z_]+$/.test(col)) throw new Error("invalid");
        await d.exec("set role service_role");
        try {
          const r = await d.query(`select ${cols} from public.${table} where ${col} = any($1)`, [values]);
          return { data: r.rows, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message, code: "42501" } };
        } finally {
          await d.exec("reset role");
        }
      },
    }),
  });
  return { ...rpc, from } as unknown as ServerSupabaseClient;
}

async function seed(opts: { aiStatus?: string; text?: string | null; withConversation?: boolean } = {}) {
  const id = `01STORE${String(++seq).padStart(10, "0")}`;
  await db.query(
    `insert into public.line_webhook_events
       (webhook_event_id, event_type, status, processed_at, needs_owner_notification)
     values ($1, 'message', 'done', now(), true)`,
    [id],
  );
  if (opts.withConversation !== false) {
    await db.query(
      `insert into public.conversations (line_event_id, line_user_id, message_type, user_message, ai_status, needs_owner)
       values ($1, $2, 'text', $3, $4, true)`,
      [id, CUSTOMER, opts.text === undefined ? "カラーの薬剤について相談したい 090-1111-2222" : opts.text, opts.aiStatus ?? "cannot_answer"],
    );
  }
  return id;
}

function notifier(push: LinePushClient["push"]) {
  const logger = silentLogger();
  const n = createOwnerNotifier({
    mode: "live",
    store: new SupabaseOwnerNotificationStore(client(db)),
    push: { push: vi.fn(push) },
    loadOwnerId: async () => OWNER,
    appBaseUrl: "https://salon.example.com",
    logger,
  });
  return { n, logger };
}

const notified = async () =>
  (await db.query<{ e: number; c: number }>(
    `select (select count(*)::int from public.line_webhook_events where owner_notified_at is not null) as e,
            (select count(*)::int from public.conversations where owner_notified_at is not null) as c`,
  )).rows[0];

beforeEach(async () => {
  db = await createMigratedDb();
});

describe("SupabaseOwnerNotificationStore（PGlite）", () => {
  it("未通知のイベントをまとめて 1 通で送り、イベントと会話ログに通知日時を記録する", async () => {
    await seed();
    await seed({ aiStatus: "unsupported", text: null });
    await seed({ withConversation: false });
    const sent: string[] = [];
    const { n, logger } = notifier(async (_to, messages) => {
      sent.push(messages[0].text);
      return "sent";
    });

    expect(await n.flush()).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("【要対応】LINE のお問い合わせ 3 件");
    expect(sent[0]).toContain("確認が必要な質問「カラーの薬剤について相談したい [電話番…」");
    expect(sent[0]).toContain("画像・スタンプなど");
    expect(sent[0]).not.toContain(CUSTOMER);
    expect(sent[0]).not.toContain("1111");
    expect(await notified()).toEqual({ e: 3, c: 2 });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("カラー");

    // 送信済みのものは二度と送らない（未通知がなければ nothing）
    expect(await n.flush()).toBe("nothing");
    await db.exec("update public.owner_notification_batches set last_attempt_at = now() - interval '11 minutes'");
    expect(await n.flush()).toBe("nothing");
    expect(sent).toHaveLength(1);
  });

  it("成否不明（5xx）なら記録せず、次回は同じ再送キーで送る。LINE が受理済み（409）なら送信済みにする", async () => {
    await seed();
    const keys: string[] = [];
    let first = true;
    const { n } = notifier(async (_to, _m, key) => {
      keys.push(key);
      if (first) {
        first = false;
        throw new LineApiError(500, "error");
      }
      return "duplicate";
    });
    expect(await n.flush()).toBe("unknown");
    expect(await notified()).toEqual({ e: 0, c: 0 });

    await db.exec("update public.owner_notification_batches set last_attempt_at = now() - interval '11 minutes'");
    expect(await n.flush()).toBe("sent");
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(await notified()).toEqual({ e: 1, c: 1 });
  });

  it("LINE が拒否（4xx）したら未通知のまま残し、次のまとめで新しいキーで送る", async () => {
    await seed();
    const keys: string[] = [];
    let first = true;
    const { n } = notifier(async (_to, _m, key) => {
      keys.push(key);
      if (first) {
        first = false;
        throw new LineApiError(400, "bad");
      }
      return "sent";
    });
    expect(await n.flush()).toBe("failed");
    expect(await notified()).toEqual({ e: 0, c: 0 });
    await db.exec("update public.owner_notification_batches set last_attempt_at = now() - interval '11 minutes'");
    expect(await n.flush()).toBe("sent");
    expect(keys[1]).not.toBe(keys[0]);
    const r = await db.query<{ status: string; last_error: string | null }>(
      "select status, last_error from public.owner_notification_batches order by created_at",
    );
    expect(r.rows).toEqual([
      { status: "failed", last_error: "push_http_400" },
      { status: "sent", last_error: null },
    ]);
  });

  it("並列に flush しても push は 1 回だけ", async () => {
    await seed();
    await seed();
    const push = vi.fn(async () => "sent" as const);
    const { n } = notifier(push);
    const results = await Promise.all([n.flush(), n.flush(), n.flush()]);
    expect(push).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
  });
});

describe("確保の戻り値の検証", () => {
  it("想定外の形は DbError（送信しない）", () => {
    expect(() => parseClaimResult(null)).toThrow(DbError);
    expect(() => parseClaimResult({ result: "claimed", batch_id: "x" })).toThrow(DbError);
    expect(() => parseClaimResult({ result: "sent" })).toThrow(DbError);
    expect(parseClaimResult({ result: "busy" })).toEqual({ result: "busy" });
  });

  it("DB エラーはコードだけの DbError", async () => {
    const failing = pgliteRpcClient(db, { failWith: () => new Error("boom") });
    const store = new SupabaseOwnerNotificationStore(failing);
    await expect(store.claim({ urgent: false, limits: { intervalMinutes: 10, dailyLimit: 5, maxAttempts: 3 } })).rejects.toThrow(
      /claimOwnerNotificationBatch failed \(TEST_FAILURE\)/,
    );
  });
});
