import { describe, expect, it } from "vitest";
import { adminCookieOptions } from "@/lib/admin/cookie-options";
import nextConfig from "../../next.config";

/** セキュリティの設定（ログイン Cookie・レスポンスヘッダー）が意図どおりであること */

describe("ログイン Cookie の設定", () => {
  it("JavaScript から読めない（HttpOnly）。他サイトからの POST には付かない（SameSite=Lax）", () => {
    expect(adminCookieOptions({} as NodeJS.ProcessEnv)).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it("本番では HTTPS のときだけ送る（Secure）。ローカルの開発・テストでは http でも使える", () => {
    expect(adminCookieOptions({ NODE_ENV: "production" } as NodeJS.ProcessEnv).secure).toBe(true);
    expect(adminCookieOptions({ NODE_ENV: "development" } as NodeJS.ProcessEnv).secure).toBe(false);
    expect(adminCookieOptions({ NODE_ENV: "test" } as NodeJS.ProcessEnv).secure).toBe(false);
  });
});

describe("セキュリティ用のレスポンスヘッダー", () => {
  it("全ページで iframe への埋め込みを禁止し、MIME の推測を止める", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all).toBeDefined();
    const h = Object.fromEntries(all!.headers.map((x) => [x.key, x.value]));
    expect(h).toMatchObject({
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
  });
});
