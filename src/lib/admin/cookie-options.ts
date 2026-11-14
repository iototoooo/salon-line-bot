import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * 管理画面のログイン Cookie（Supabase Auth のセッション）の設定。src/proxy.ts と src/lib/admin/session.ts で共通に使う。
 *
 * - httpOnly: true … この管理画面はブラウザ側で Supabase を使わない（サーバーだけが Cookie を読む）ため、
 *   JavaScript から読めないようにする（スクリプトを埋め込まれた場合にセッションを盗まれにくくする）
 * - secure: 本番（NODE_ENV=production）では HTTPS のときだけ送る。ローカル（http://localhost）の開発・テストでは false
 * - sameSite: "lax" … 他のサイトからの POST には Cookie を付けない（Server Actions は Next.js が送信元も確認する）
 * maxAge は @supabase/ssr の既定値（400 日）。実際のログインの有効期間は Supabase Auth の設定で決まる。
 */
export function adminCookieOptions(env: NodeJS.ProcessEnv = process.env): CookieOptionsWithName {
  return {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: env.NODE_ENV === "production",
  };
}
