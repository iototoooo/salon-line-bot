import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { adminCookieOptions } from "@/lib/admin/cookie-options";
import { readSupabasePublicConfig } from "@/lib/supabase/public-config";
import type { Database } from "@/types/database";

/**
 * 管理画面（/admin 配下）へのアクセス時に、ログインのセッション（Cookie）を更新し、
 * 未ログインならログイン画面へ移動させる。
 *
 * これは「楽観的なチェック」で、最終的な判定（管理者かどうか）は各ページ・Server Action の requireAdmin で行う。
 * Webhook・Cron などの API には適用しない（matcher で /admin だけに限定）。
 */
export async function proxy(request: NextRequest) {
  let config: ReturnType<typeof readSupabasePublicConfig>;
  try {
    config = readSupabasePublicConfig();
  } catch {
    config = null;
  }
  if (!config) return redirectToLogin(request, "config");

  let response = NextResponse.next({ request });
  const supabase = createServerClient<Database>(config.url, config.publishableKey, {
    cookieOptions: adminCookieOptions(),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list, headers) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
        for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
      },
    },
  });

  // Auth サーバーでトークンを検証し、必要なら更新する（更新された Cookie は response に書き込まれる）
  let signedIn = false;
  try {
    const { data } = await supabase.auth.getUser();
    signedIn = !!data.user;
  } catch {
    signedIn = false;
  }
  if (!signedIn) return redirectToLogin(request);

  // 管理画面は個人の情報を含むため、共有キャッシュに保存させない
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function redirectToLogin(request: NextRequest, error?: string) {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  const next = request.nextUrl.pathname + request.nextUrl.search;
  if (next !== "/admin") url.searchParams.set("next", next);
  if (error) url.searchParams.set("error", error);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
