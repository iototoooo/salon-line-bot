import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyDbError, runConnectionCheck, verifyShopSettings } from "@/lib/supabase/connection-check";
import {
  createServerSupabaseClient,
  readSupabaseServerConfig,
  SUPABASE_PROJECT_REF,
  type ServerSupabaseClient,
} from "@/lib/supabase/server";

// 実在しないダミー値。実際の Supabase には接続しない（fetch はすべてスタブ）
const URL_OK = `https://${SUPABASE_PROJECT_REF}.supabase.co`;
const SECRET = "sb_secret_DUMMYdummyDUMMYdummy0123";
const ENV = { SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: SECRET } as unknown as NodeJS.ProcessEnv;

/** 実際の createServerSupabaseClient を使い、fetch だけを差し替えて実行する */
async function runWith(respond: () => Promise<Response> | Response, env: NodeJS.ProcessEnv = ENV) {
  const requests: Array<{ method: string; url: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ method: init?.method ?? "GET", url: String(input) });
      return respond();
    }),
  );
  const logs: string[] = [];
  const code = await runConnectionCheck(env, {
    readConfig: readSupabaseServerConfig,
    createClient: createServerSupabaseClient,
    log: (l) => logs.push(l),
  });
  return { code, logs, text: logs.join("\n"), requests };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("接続確認：読み取り成功", () => {
  it("初期行があり bot_enabled = false なら合格（終了コード 0）。接続先の Ref を表示する", async () => {
    const r = await runWith(() => json([{ id: 1, bot_enabled: false }]));
    expect(r.code).toBe(0);
    expect(r.text).toContain(`接続先: ${URL_OK}（Project Ref: ${SUPABASE_PROJECT_REF}）`);
    expect(r.text).toContain("キーの種類: secret key");
    expect(r.text).toContain("[OK] 自動応答が OFF（bot_enabled = false）");
    expect(r.text).toContain("結果: 合格");
  });

  it("送信するのは shop_settings の id・bot_enabled を読む GET 1 回だけ", async () => {
    const r = await runWith(() => json([{ id: 1, bot_enabled: false }]));
    expect(r.requests).toEqual([{ method: "GET", url: `${URL_OK}/rest/v1/shop_settings?select=id%2Cbot_enabled` }]);
  });
});

describe("接続確認：内容が想定と異なる", () => {
  it("bot_enabled = true なら不合格（unexpected_data）", async () => {
    const r = await runWith(() => json([{ id: 1, bot_enabled: true }]));
    expect(r.code).toBe(1);
    expect(r.text).toContain("[NG] 自動応答が OFF（bot_enabled = false）（bot_enabled = true）");
    expect(r.text).toContain("結果: 不合格（unexpected_data）");
  });

  it.each([
    ["0 行", []],
    ["2 行", [{ id: 1, bot_enabled: false }, { id: 2, bot_enabled: false }]],
  ])("初期行が %s なら不合格", async (_l, rows) => {
    const r = await runWith(() => json(rows));
    expect(r.code).toBe(1);
    expect(r.text).toContain("[NG] 初期行（id = 1）が 1 行だけある");
  });
});

describe("接続確認：エラーの分類", () => {
  it.each([
    ["無効なキー・別プロジェクトのキー（401）", () => json({ message: "Invalid API key" }, 401), "auth"],
    ["権限不足（42501）", () => json({ code: "42501", message: "permission denied for table shop_settings" }, 403), "permission"],
    ["テーブルなし（PGRST205）", () => json({ code: "PGRST205", message: "Could not find the table" }, 404), "schema"],
    ["サーバーエラー（500）", () => json({ message: "oops" }, 500), "unknown"],
  ])("%s → %s", async (_l, respond, category) => {
    const r = await runWith(respond);
    expect(r.code).toBe(1);
    expect(r.text).toContain(`結果: 不合格（${category}`);
  });

  it("通信エラー（DNS・接続拒否） → network", async () => {
    const r = await runWith(() => Promise.reject(new TypeError("fetch failed")));
    expect(r.code).toBe(1);
    expect(r.text).toContain("結果: 不合格（network");
  });

  it("タイムアウト → timeout", async () => {
    const r = await runWith(() => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
    expect(r.code).toBe(1);
    expect(r.text).toContain("結果: 不合格（timeout");
  });

  it("エラー本文（メッセージ）は表示せず、分類・コード・ステータスだけを表示する", async () => {
    const r = await runWith(() => json({ code: "42501", message: "permission denied: secret-detail" }, 403));
    expect(r.text).toContain("code=42501, status=403");
    expect(r.text).not.toContain("secret-detail");
  });

  it("classifyDbError：想定外の形式のコードは表示しない", () => {
    expect(classifyDbError({ code: "x".repeat(50) }, 500)).toEqual({ category: "unknown", code: undefined });
  });
});

describe("接続確認：設定エラー（接続しない）", () => {
  it.each([
    ["未設定", {}],
    ["URL 不一致", { SUPABASE_URL: "https://otherprojectaaaaaaaaa.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SECRET }],
    ["publishable key", { SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_DUMMYdummyDUMMY0123" }],
    ["形式不明のキー", { SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: "wrong-format-key" }],
  ])("%s → 終了コード 2、リクエストは送らない", async (_l, e) => {
    const r = await runWith(() => json([]), e as unknown as NodeJS.ProcessEnv);
    expect(r.code).toBe(2);
    expect(r.requests).toEqual([]);
    expect(r.text).toContain("[NG] 設定エラー");
  });
});

describe("接続確認：機密情報を出力しない", () => {
  it("成功・失敗・設定エラーのどの場合もログにキーの値が含まれない", async () => {
    const scenarios: Array<[() => Promise<Response> | Response, NodeJS.ProcessEnv]> = [
      [() => json([{ id: 1, bot_enabled: false }]), ENV],
      [() => json([{ id: 1, bot_enabled: true }]), ENV],
      [() => json({ message: `Invalid API key ${SECRET}` }, 401), ENV],
      [() => Promise.reject(new TypeError(`fetch failed ${SECRET}`)), ENV],
      [() => json([]), { SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: ` ${SECRET}` } as unknown as NodeJS.ProcessEnv],
      [() => json([]), { NEXT_PUBLIC_SUPABASE_ANON_KEY: SECRET } as unknown as NodeJS.ProcessEnv],
    ];
    for (const [respond, env] of scenarios) {
      const r = await runWith(respond, env);
      expect(r.text).not.toContain(SECRET);
      expect(r.text).not.toContain("sb_secret_DUMMY");
    }
  });
});

describe("verifyShopSettings は読み取りしかしない", () => {
  it("from().select() だけを呼び、insert / update / delete / upsert / rpc を呼ばない", async () => {
    const called: string[] = [];
    const builder: Record<string, unknown> = {};
    const result = { data: [{ id: 1, bot_enabled: false }], error: null, status: 200 };
    for (const m of ["select", "insert", "update", "delete", "upsert"]) {
      builder[m] = () => {
        called.push(m);
        return { retry: (enabled: boolean) => (called.push(`retry:${enabled}`), Promise.resolve(result)) };
      };
    }
    const db = {
      from: (t: string) => {
        called.push(`from:${t}`);
        return builder;
      },
      rpc: () => {
        called.push("rpc");
      },
    } as unknown as ServerSupabaseClient;
    expect((await verifyShopSettings(db)).ok).toBe(true);
    expect(called).toEqual(["from:shop_settings", "select", "retry:false"]);
  });
});
