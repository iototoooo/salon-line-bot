import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifySupabaseKey,
  createServerSupabaseClient,
  readSupabaseServerConfig,
  SUPABASE_PROJECT_REF,
  SupabaseConfigError,
} from "@/lib/supabase/server";

// すべて実在しないダミー値（形式だけ合わせたもの）
const URL_OK = `https://${SUPABASE_PROJECT_REF}.supabase.co`;
const SECRET = "sb_secret_DUMMYdummyDUMMYdummy0123";
const PUBLISHABLE = "sb_publishable_DUMMYdummyDUMMY0123";
const fakeJwt = (payload: Record<string, unknown>) =>
  `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.ZmFrZXNpZ25hdHVyZQ`;
const LEGACY_SERVICE = fakeJwt({ iss: "supabase", ref: SUPABASE_PROJECT_REF, role: "service_role" });
const LEGACY_SERVICE_OTHER = fakeJwt({ iss: "supabase", ref: "otherprojectaaaaaaaaa", role: "service_role" });
const LEGACY_ANON = fakeJwt({ iss: "supabase", ref: SUPABASE_PROJECT_REF, role: "anon" });

const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;
const read = (v: Record<string, string>) => readSupabaseServerConfig(env(v));
const codeOf = (v: Record<string, string>) => {
  try {
    read(v);
    return "no_error";
  } catch (e) {
    return e instanceof SupabaseConfigError ? e.code : "other_error";
  }
};

describe("readSupabaseServerConfig：キーの種類", () => {
  it("secret key（sb_secret_）を受け付ける", () => {
    expect(read({ SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: SECRET })).toEqual({
      url: URL_OK,
      serviceRoleKey: SECRET,
      projectRef: SUPABASE_PROJECT_REF,
      keyKind: "secret",
    });
  });

  it("legacy の service_role キーは、同じプロジェクトのものなら予備として受け付ける", () => {
    expect(read({ SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE })?.keyKind).toBe("legacy_service_role");
  });

  it.each([
    ["publishable key", PUBLISHABLE, "publishable_key"],
    ["legacy anon キー", LEGACY_ANON, "legacy_anon_key"],
    ["別プロジェクトの legacy service_role キー", LEGACY_SERVICE_OTHER, "legacy_key_ref_mismatch"],
    ["形式不明の文字列", "not-a-key", "unknown_key_format"],
    ["短すぎる sb_secret_", "sb_secret_abc", "unknown_key_format"],
    ["未知の sb_ 形式", "sb_temp_DUMMYdummyDUMMY", "unknown_key_format"],
    ["前後の空白", ` ${SECRET}`, "key_has_whitespace"],
    ["引用符付き", `"${SECRET}"`, "key_has_whitespace"],
  ])("%s → %s", (_l, key, code) => {
    expect(codeOf({ SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: key })).toBe(code);
  });

  it("新形式のキーは JWT として解析しない（接頭辞だけで判定）", () => {
    const decode = vi.spyOn(Buffer, "from");
    expect(classifySupabaseKey(SECRET)).toEqual({ kind: "secret" });
    expect(classifySupabaseKey(PUBLISHABLE)).toEqual({ kind: "publishable" });
    expect(decode).not.toHaveBeenCalled();
    decode.mockRestore();
  });
});

describe("readSupabaseServerConfig：接続先 URL", () => {
  it("末尾のスラッシュは許可し、正規化する。NEXT_PUBLIC_SUPABASE_URL も使える", () => {
    expect(read({ SUPABASE_URL: `${URL_OK}/`, SUPABASE_SERVICE_ROLE_KEY: SECRET })?.url).toBe(URL_OK);
    expect(read({ NEXT_PUBLIC_SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: SECRET })?.url).toBe(URL_OK);
  });

  it.each([
    ["別プロジェクト", "https://otherprojectaaaaaaaaa.supabase.co"],
    ["http", `http://${SUPABASE_PROJECT_REF}.supabase.co`],
    ["パス付き", `${URL_OK}/rest/v1`],
    ["ポート付き", `${URL_OK}:8443`],
    ["似たホスト名", `https://${SUPABASE_PROJECT_REF}.supabase.co.example.com`],
    ["ローカル", "http://127.0.0.1:54321"],
  ])("%s → url_mismatch（接続しない）", (_l, url) => {
    expect(codeOf({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: SECRET })).toBe("url_mismatch");
  });

  it("URL として解釈できなければ invalid_url", () => {
    expect(codeOf({ SUPABASE_URL: "x.example", SUPABASE_SERVICE_ROLE_KEY: SECRET })).toBe("invalid_url");
  });
});

describe("readSupabaseServerConfig：未設定・公開変数", () => {
  it("URL かキーが未設定なら null（開発時はメモリ実装）", () => {
    expect(read({})).toBeNull();
    expect(read({ SUPABASE_URL: URL_OK })).toBeNull();
    expect(read({ SUPABASE_SERVICE_ROLE_KEY: SECRET })).toBeNull();
  });

  it.each([
    ["secret key", SECRET],
    ["legacy service_role キー", LEGACY_SERVICE],
  ])("NEXT_PUBLIC_ の変数に %s があればエラー（サーバー設定が未設定でも）", (_l, key) => {
    expect(codeOf({ NEXT_PUBLIC_SUPABASE_ANON_KEY: key })).toBe("secret_in_public_env");
  });

  it("NEXT_PUBLIC_ に publishable key があるのは正常", () => {
    expect(read({ SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: SECRET, NEXT_PUBLIC_SUPABASE_ANON_KEY: PUBLISHABLE })).not.toBeNull();
  });

  it("どのエラーメッセージにもキーの値が含まれない", () => {
    const cases: Array<Record<string, string>> = [
      { SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: PUBLISHABLE },
      { SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: LEGACY_ANON },
      { SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: ` ${SECRET}` },
      { SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc" },
      { SUPABASE_URL: "https://otherprojectaaaaaaaaa.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SECRET },
      { NEXT_PUBLIC_LEAK: SECRET },
    ];
    for (const c of cases) {
      const err = (() => {
        try {
          read(c);
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).toBeInstanceOf(SupabaseConfigError);
      for (const secret of [SECRET, PUBLISHABLE, LEGACY_ANON, "sb_secret_abc"]) {
        expect(err?.message).not.toContain(secret);
      }
    }
  });
});

describe("createServerSupabaseClient が送るリクエスト（fetch はスタブ・実接続なし）", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch() {
    const calls: Array<{ url: string; method: string; headers: Headers }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
      return new Response(JSON.stringify([{ id: 1, bot_enabled: false }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { calls, fetchMock };
  }

  it("secret key は apikey ヘッダーだけで送り、Authorization: Bearer には入れない", async () => {
    const { calls } = stubFetch();
    const config = read({ SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: SECRET })!;
    await createServerSupabaseClient(config, { readOnly: true }).from("shop_settings").select("id, bot_enabled");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${URL_OK}/rest/v1/shop_settings?select=id%2Cbot_enabled`);
    expect(calls[0].headers.get("apikey")).toBe(SECRET);
    expect(calls[0].headers.has("Authorization")).toBe(false);
  });

  it("legacy の JWT キーは従来どおり Authorization: Bearer も付ける", async () => {
    const { calls } = stubFetch();
    const config = read({ SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE })!;
    await createServerSupabaseClient(config, { readOnly: true }).from("shop_settings").select("id");
    expect(calls[0].headers.get("Authorization")).toBe(`Bearer ${LEGACY_SERVICE}`);
  });

  it("readOnly のクライアントは書き込み・RPC を送信前に拒否する", async () => {
    const { fetchMock } = stubFetch();
    const config = read({ SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: SECRET })!;
    const db = createServerSupabaseClient(config, { readOnly: true });
    const results = await Promise.all([
      db.from("shop_settings").update({ bot_enabled: true }).eq("id", 1),
      db.from("faqs").insert({ question: "q", answer: "a" }),
      db.from("faqs").delete().eq("id", "x"),
      db.rpc("begin_line_reply", { p_webhook_event_id: "x" }),
    ]);
    expect(results.every((r) => r.error !== null)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
