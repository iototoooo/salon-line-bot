import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "@/app/api/cron/retention/route";
import { DbError } from "@/lib/db/errors";
import { parseRetentionResult, type RetentionStore, SupabaseRetentionStore } from "@/lib/db/retention";
import { MIN_CRON_SECRET_LENGTH } from "@/lib/notify/cron";
import { handleRetentionCron, type RetentionCronDeps } from "@/lib/retention/cron";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import { SUPABASE_PROJECT_REF } from "@/lib/supabase/server";

/**
 * 保持期間の削除の定期実行（Vercel Schedules → GET /api/cron/retention）。
 * 実際の Supabase には接続しない（DB 関数そのものは tests/db/retention.sql.test.ts で検証）。
 */
const SECRET = "r".repeat(MIN_CRON_SECRET_LENGTH);
const req = (auth?: string) =>
  new Request("https://example.invalid/api/cron/retention", { headers: auth ? { authorization: auth } : {} });
const PURGED = {
  result: "purged",
  conversations: 3,
  line_webhook_events: 12,
  ai_usage_reservations: 5,
  owner_notification_batches: 1,
};
const logger = () => ({ info: vi.fn(), error: vi.fn() });

function deps(store: RetentionStore | null) {
  const l = logger();
  const getDeps = vi.fn((): RetentionCronDeps => ({ store, logger: l }));
  return { getDeps, logger: l };
}
const storeOf = (impl: RetentionStore["purge"]): RetentionStore => ({ purge: vi.fn(impl) });

describe("DB の戻り値の検証（parseRetentionResult）", () => {
  it("削除件数を受け取る", () => {
    expect(parseRetentionResult(PURGED)).toEqual({
      result: "purged",
      deleted: { conversations: 3, lineWebhookEvents: 12, aiUsageReservations: 5, ownerNotificationBatches: 1 },
    });
  });

  it("busy（別の削除処理が実行中）", () => {
    expect(parseRetentionResult({ result: "busy" })).toEqual({ result: "busy" });
  });

  it.each([
    ["null", null],
    ["配列", [PURGED]],
    ["文字列", "purged"],
    ["未知の result", { ...PURGED, result: "deleted" }],
    ["件数が欠けている", { result: "purged", conversations: 1 }],
    ["負の件数", { ...PURGED, conversations: -1 }],
    ["小数", { ...PURGED, line_webhook_events: 1.5 }],
    ["文字列の件数", { ...PURGED, ai_usage_reservations: "5" }],
  ])("想定外の形（%s）は DbError（unexpected_result）", (_l, data) => {
    expect(() => parseRetentionResult(data)).toThrow(DbError);
  });
});

describe("SupabaseRetentionStore", () => {
  it("引数なしで public.run_retention_purge を呼ぶ（保持期間はアプリから渡さない）", async () => {
    const rpc = vi.fn(async () => ({ data: PURGED, error: null }));
    const store = new SupabaseRetentionStore({ rpc } as unknown as ServerSupabaseClient);
    expect((await store.purge()).result).toBe("purged");
    expect(rpc).toHaveBeenCalledWith("run_retention_purge");
  });

  it("DB エラー（関数が未適用など）はコードだけの DbError", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }));
    const store = new SupabaseRetentionStore({ rpc } as unknown as ServerSupabaseClient);
    await expect(store.purge()).rejects.toMatchObject({ name: "DbError", code: "PGRST202" });
  });
});

describe("handleRetentionCron", () => {
  it("正しい Bearer で削除し、件数だけを返す（200・キャッシュしない）", async () => {
    const store = storeOf(async () => parseRetentionResult(PURGED));
    const { getDeps } = deps(store);
    const res = await handleRetentionCron(req(`Bearer ${SECRET}`), SECRET, getDeps);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ok: true,
      result: "purged",
      deleted: { conversations: 3, lineWebhookEvents: 12, aiUsageReservations: 5, ownerNotificationBatches: 1 },
    });
    expect(store.purge).toHaveBeenCalledTimes(1);
  });

  it("別の削除処理が実行中なら 200（busy）。失敗扱いにしない", async () => {
    const { getDeps } = deps(storeOf(async () => ({ result: "busy" })));
    const res = await handleRetentionCron(req(`Bearer ${SECRET}`), SECRET, getDeps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: "busy" });
  });

  it("重複・遅延後のまとめ実行で続けて呼ばれても安全（毎回 DB に任せ、2 回目は 0 件）", async () => {
    const purge = vi
      .fn<RetentionStore["purge"]>()
      .mockResolvedValueOnce(parseRetentionResult(PURGED))
      .mockResolvedValueOnce(
        parseRetentionResult({ result: "purged", conversations: 0, line_webhook_events: 0, ai_usage_reservations: 0, owner_notification_batches: 0 }),
      );
    const { getDeps } = deps({ purge });
    const r1 = await handleRetentionCron(req(`Bearer ${SECRET}`), SECRET, getDeps);
    const r2 = await handleRetentionCron(req(`Bearer ${SECRET}`), SECRET, getDeps);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect((await r2.json()).deleted.conversations).toBe(0);
  });

  it.each([
    ["ヘッダーなし", undefined],
    ["違う値", `Bearer ${"x".repeat(MIN_CRON_SECRET_LENGTH)}`],
    ["Bearer なし", SECRET],
  ])("認証に失敗（%s）したら 401。設定の読み込みも削除もしない", async (_l, auth) => {
    const store = storeOf(async () => ({ result: "busy" }));
    const { getDeps } = deps(store);
    const res = await handleRetentionCron(req(auth), SECRET, getDeps);
    expect(res.status).toBe(401);
    expect(getDeps).not.toHaveBeenCalled();
    expect(store.purge).not.toHaveBeenCalled();
  });

  it.each([
    ["未設定", undefined],
    ["空白だけ", "   "],
    ["短すぎる", "s".repeat(MIN_CRON_SECRET_LENGTH - 1)],
  ])("CRON_SECRET が%sなら 503（無効）", async (_l, secret) => {
    const { getDeps } = deps(storeOf(async () => ({ result: "busy" })));
    const res = await handleRetentionCron(req(`Bearer ${secret ?? ""}`), secret, getDeps);
    expect(res.status).toBe(503);
    expect(getDeps).not.toHaveBeenCalled();
  });

  it("Supabase の接続情報がなければ 500（設定漏れとして実行履歴に残す）", async () => {
    const { getDeps, logger: l } = deps(null);
    const res = await handleRetentionCron(req(`Bearer ${SECRET}`), SECRET, getDeps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "not_configured" });
    expect(l.error).toHaveBeenCalled();
  });

  it("DB エラーは 500。応答に詳細を含めず、ログはコードだけ", async () => {
    const { getDeps, logger: l } = deps(
      storeOf(async () => {
        throw new DbError("runRetentionPurge", "PGRST202");
      }),
    );
    const res = await handleRetentionCron(req(`Bearer ${SECRET}`), SECRET, getDeps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "purge_failed" });
    expect(l.error).toHaveBeenCalledWith("[cron:retention] purge failed", "runRetentionPurge:PGRST202");
  });

  it("想定外の例外も 500。メッセージ（接続先など）はログにも応答にも出さない", async () => {
    const { getDeps, logger: l } = deps(
      storeOf(async () => {
        throw new Error("connect to https://secret.example failed");
      }),
    );
    const res = await handleRetentionCron(req(`Bearer ${SECRET}`), SECRET, getDeps);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret.example");
    expect(JSON.stringify(l.error.mock.calls)).not.toContain("secret.example");
  });

  it("設定の読み込みエラーは 500（詳細は返さない）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleRetentionCron(req(`Bearer ${SECRET}`), SECRET, () => {
      throw new Error("SUPABASE_URL is wrong: https://secret.example");
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret.example");
  });
});

describe("ルート（GET /api/cron/retention）と環境変数", () => {
  const ENV_KEYS = ["CRON_SECRET", "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "VERCEL_ENV"];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const k of ENV_KEYS) vi.stubEnv(k, "");
    fetchMock = vi.fn(async () => new Response(JSON.stringify(PURGED), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const setSupabase = () => {
    vi.stubEnv("SUPABASE_URL", `https://${SUPABASE_PROJECT_REF}.supabase.co`);
    // テスト専用のダミー値（実在しない）
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_DUMMYdummyDUMMYdummy0123");
  };

  it("GET と maxDuration（60 秒）だけを公開する（POST は 405。vercel.json で requestMethod: GET を指定）", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "maxDuration"]);
    expect(route.maxDuration).toBe(60);
  });

  it("CRON_SECRET が未設定なら 503。DB に接続しない", async () => {
    setSupabase();
    const res = await route.GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("クエリ文字列での秘密の指定は受け付けない（401）", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    setSupabase();
    const res = await route.GET(new Request(`https://example.invalid/api/cron/retention?secret=${SECRET}`));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("認証後は対象プロジェクトの rpc/run_retention_purge だけを POST で呼ぶ（引数なし）。応答に秘密・接続先を含めない", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    setSupabase();
    const res = await route.GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    expect(String(url)).toBe(`https://${SUPABASE_PROJECT_REF}.supabase.co/rest/v1/rpc/run_retention_purge`);
    expect(init.method).toBe("POST");
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(SUPABASE_PROJECT_REF);
    expect(text).not.toContain("sb_secret");
  });

  it("Supabase の接続情報がなければ 500（何も削除しない）", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await route.GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
