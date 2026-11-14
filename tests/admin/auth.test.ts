import { describe, expect, it } from "vitest";
import { resolveAdmin, safeAdminPath } from "@/lib/admin/auth-core";
import { LOGIN_FAILED, LOGIN_UNAVAILABLE, login } from "@/lib/admin/login-core";
import { readAdminModes } from "@/lib/admin/mode";
import { readSupabasePublicConfig } from "@/lib/supabase/public-config";
import { SUPABASE_PROJECT_REF } from "@/lib/supabase/server";
import { ADMIN_ID, fakeSession } from "./fake-session";

// 実在しないダミー値
const URL_OK = `https://${SUPABASE_PROJECT_REF}.supabase.co`;
const PUBLISHABLE = "sb_publishable_DUMMYdummy0123456789";
const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;
const form = (v: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, x] of Object.entries(v)) fd.set(k, x);
  return fd;
};

describe("公開用の接続設定（NEXT_PUBLIC_SUPABASE_URL・ANON_KEY）", () => {
  it("未設定なら null（ログインできない状態。DB に接続しない）", () => {
    expect(readSupabasePublicConfig(env({}))).toBeNull();
    expect(readSupabasePublicConfig(env({ NEXT_PUBLIC_SUPABASE_URL: URL_OK }))).toBeNull();
  });

  it("本案件のプロジェクトと publishable key だけを受け付ける", () => {
    expect(readSupabasePublicConfig(env({ NEXT_PUBLIC_SUPABASE_URL: URL_OK, NEXT_PUBLIC_SUPABASE_ANON_KEY: PUBLISHABLE }))).toEqual({
      url: URL_OK,
      publishableKey: PUBLISHABLE,
    });
  });

  it("ブラウザ自動テスト用のローカル URL は NODE_ENV=test のときだけ許可（本番・開発では拒否）", () => {
    const e2e = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54329", NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_E2E_dummy", E2E_FAKE_SUPABASE_URL: "http://127.0.0.1:54329" };
    expect(readSupabasePublicConfig(env({ ...e2e, NODE_ENV: "test" }))).toEqual({ url: "http://127.0.0.1:54329", publishableKey: "sb_publishable_E2E_dummy" });
    expect(() => readSupabasePublicConfig(env({ ...e2e, NODE_ENV: "production" }))).toThrow(/must be https/);
    expect(() => readSupabasePublicConfig(env({ ...e2e, NODE_ENV: "development" }))).toThrow(/must be https/);
    // 偽のサーバーには本物のキーを使わせない
    expect(() => readSupabasePublicConfig(env({ ...e2e, NODE_ENV: "test", NEXT_PUBLIC_SUPABASE_ANON_KEY: PUBLISHABLE }))).toThrow(/dummy publishable key/);
    // ローカル以外の URL は許可しない
    expect(() => readSupabasePublicConfig(env({ ...e2e, NODE_ENV: "test", E2E_FAKE_SUPABASE_URL: "http://evil.example:54329", NEXT_PUBLIC_SUPABASE_URL: "http://evil.example:54329" }))).toThrow(/must be https/);
  });

  it.each([
    ["別プロジェクトの URL", "https://other.supabase.co", PUBLISHABLE, /must be https/],
    ["http の URL", `http://${SUPABASE_PROJECT_REF}.supabase.co`, PUBLISHABLE, /must be https/],
    ["secret key（ブラウザに配布される変数に秘密キー）", URL_OK, "sb_secret_DUMMYdummyDUMMYdummy0123", /server-only secret key/],
    ["形式不明のキー", URL_OK, "not-a-key", /publishable key/],
    ["空白入りのキー", URL_OK, `${PUBLISHABLE} x`, /whitespace/],
  ])("%s はエラー", (_l, url, key, error) => {
    expect(() =>
      readSupabasePublicConfig(env({ NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: key })),
    ).toThrow(error);
  });
});

describe("安全スイッチ（既定はすべて OFF）", () => {
  it("未設定なら、書き込み・LINE 送信・AI 回答テストはすべて無効", () => {
    expect(readAdminModes(env({}))).toEqual({ writeEnabled: false, lineSendEnabled: false, answerTestAiEnabled: false });
  });

  it("LINE_REPLY_MODE=live だけでは配信できない（別のスイッチ）", () => {
    expect(readAdminModes(env({ LINE_REPLY_MODE: "live", LINE_CHANNEL_ACCESS_TOKEN: "dummy" })).lineSendEnabled).toBe(false);
  });

  it("明示したときだけ有効。トークン・API キーがなければ有効にならない", () => {
    expect(readAdminModes(env({ ADMIN_WRITE_MODE: "enabled" })).writeEnabled).toBe(true);
    expect(readAdminModes(env({ ADMIN_WRITE_MODE: "true" })).writeEnabled).toBe(false);
    expect(readAdminModes(env({ LINE_BROADCAST_MODE: "live" })).lineSendEnabled).toBe(false);
    expect(readAdminModes(env({ LINE_BROADCAST_MODE: "live", LINE_CHANNEL_ACCESS_TOKEN: "dummy" })).lineSendEnabled).toBe(true);
    expect(readAdminModes(env({ ADMIN_ANSWER_TEST_MODE: "live" })).answerTestAiEnabled).toBe(false);
    expect(readAdminModes(env({ ADMIN_ANSWER_TEST_MODE: "live", ANTHROPIC_API_KEY: "dummy" })).answerTestAiEnabled).toBe(true);
  });
});

describe("管理者の判定（resolveAdmin）", () => {
  it("ログイン中で admin_users にいれば admin", async () => {
    const { client, getUser } = fakeSession();
    expect(await resolveAdmin(client)).toEqual({ status: "admin", user: { id: ADMIN_ID, email: "owner@example.com" } });
    // Cookie の中身だけを信用せず、Auth サーバーで検証する getUser を使う
    expect(getUser).toHaveBeenCalled();
  });

  it("未ログイン・セッションの検証失敗は unauthenticated", async () => {
    expect((await resolveAdmin(fakeSession({ user: null }).client)).status).toBe("unauthenticated");
    expect((await resolveAdmin(fakeSession({ getUserError: true }).client)).status).toBe("unauthenticated");
  });

  it("ログインできても admin_users にいなければ forbidden", async () => {
    expect((await resolveAdmin(fakeSession({ isAdmin: false }).client)).status).toBe("forbidden");
  });

  it("admin_users を確認できなければ error（管理者として扱わない）", async () => {
    expect((await resolveAdmin(fakeSession({ adminQueryError: true }).client)).status).toBe("error");
  });
});

describe("ログイン後の移動先（オープンリダイレクトの防止）", () => {
  it.each([
    ["/admin/faqs", "/admin/faqs"],
    ["/admin/conversations?status=unresolved", "/admin/conversations?status=unresolved"],
    ["/admin", "/admin"],
    ["https://evil.example/admin", "/admin"],
    ["//evil.example", "/admin"],
    ["/admin//evil.example", "/admin"],
    ["/login", "/admin"],
    ["/adminx", "/admin"],
    ["javascript:alert(1)", "/admin"],
    [null, "/admin"],
  ])("%s → %s", (next, expected) => {
    expect(safeAdminPath(next)).toBe(expected);
  });
});

describe("ログイン（login）", () => {
  it("管理者ならログインして /admin（または指定の管理ページ）へ", async () => {
    const { client, signInWithPassword } = fakeSession();
    expect(await login(client, form({ email: " owner@example.com ", password: "pw", next: "/admin/inbox" }))).toEqual({
      kind: "redirect",
      to: "/admin/inbox",
    });
    expect(signInWithPassword).toHaveBeenCalledWith({ email: "owner@example.com", password: "pw" });
  });

  it("パスワード違いと、管理者でないアカウントは同じメッセージ（アカウントの有無を推測させない）", async () => {
    const wrong = await login(fakeSession({ signInError: true }).client, form({ email: "a@example.com", password: "x" }));
    const notAdmin = fakeSession({ isAdmin: false });
    const forbidden = await login(notAdmin.client, form({ email: "a@example.com", password: "x" }));
    expect(wrong).toEqual({ kind: "state", state: { status: "error", message: LOGIN_FAILED, fieldErrors: undefined } });
    expect(forbidden).toEqual(wrong);
    // 管理者でなければ、作られたセッションを直ちに破棄する
    expect(notAdmin.signOut).toHaveBeenCalled();
  });

  it("通信エラーは「時間をおいて」の案内", async () => {
    const r = await login(fakeSession({ signInThrows: true }).client, form({ email: "a@example.com", password: "x" }));
    expect(r).toMatchObject({ kind: "state", state: { message: LOGIN_UNAVAILABLE } });
  });

  it("未入力・設定なしはログインを試みない", async () => {
    const { client, signInWithPassword } = fakeSession();
    expect((await login(client, form({ email: "", password: "x" }))).kind).toBe("state");
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect((await login(null, form({ email: "a@example.com", password: "x" }))).kind).toBe("state");
  });
});
