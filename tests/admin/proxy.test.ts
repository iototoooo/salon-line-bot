import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUPABASE_PROJECT_REF } from "@/lib/supabase/server";

/**
 * src/proxy.ts（/admin 配下の未ログインをログイン画面へ）。Supabase Auth はモックし、実際には接続しない。
 */
const getUser = vi.fn();
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser } })),
}));

const { proxy, config } = await import("@/proxy");

const req = (path: string) => new NextRequest(new URL(path, "http://localhost:3000"));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `https://${SUPABASE_PROJECT_REF}.supabase.co`);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_DUMMYdummy0123456789");
  getUser.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("proxy（管理画面の入口）", () => {
  it("/admin 配下だけに適用する（Webhook・Cron の API には適用しない）", () => {
    expect(config.matcher).toEqual(["/admin", "/admin/:path*"]);
  });

  it("未ログインならログイン画面へ（元のページを next に入れる）", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const res = await proxy(req("/admin/faqs?x=1"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/admin/faqs?x=1");
  });

  it("ログイン中なら通過し、共有キャッシュに保存させない", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u" } } });
    const res = await proxy(req("/admin"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("Auth に接続できなければ未ログイン扱い", async () => {
    getUser.mockRejectedValue(new Error("network"));
    const res = await proxy(req("/admin"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("公開用の接続設定がなければ、ログイン画面に設定エラーを表示する", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const res = await proxy(req("/admin"));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("error")).toBe("config");
    expect(getUser).not.toHaveBeenCalled();
  });

  it("公開用の変数に secret キーが入っていても、接続せずに設定エラー", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_secret_DUMMYdummyDUMMYdummy0123");
    const res = await proxy(req("/admin"));
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("config");
    expect(getUser).not.toHaveBeenCalled();
  });
});
