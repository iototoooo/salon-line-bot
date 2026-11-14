import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { readSupabasePublicConfig } from "@/lib/supabase/public-config";
import type { Database } from "@/types/database";
import { type AdminUser, resolveAdmin, type SessionClient } from "./auth-core";
import { adminCookieOptions } from "./cookie-options";

/**
 * ログイン中のセッションで Supabase に接続するクライアント（サーバー専用）。
 * 公開用キー＋ユーザーのトークンで接続するため、RLS（管理者のみ許可）が適用される。secret キーは使わない。
 * リクエストごとに作る（共有しない）。Server Component では Cookie を書き換えられないため、
 * トークンの更新は proxy.ts が行う（ここでの書き込み失敗は無視する）。
 */
export async function createSessionClient(): Promise<SessionClient | null> {
  const config = readSupabasePublicConfig();
  if (!config) return null;
  const store = await cookies();
  return createServerClient<Database>(config.url, config.publishableKey, {
    cookieOptions: adminCookieOptions(),
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Server Component からは Cookie を変更できない（proxy.ts で更新される）
        }
      },
    },
  });
}

export type AdminContext = { user: AdminUser; db: SessionClient };

/**
 * 管理者としてログインしていることを確認する（ページ・Server Action の先頭で必ず呼ぶ）。
 * proxy.ts の確認は楽観的なチェックなので、データに触れる直前にここで改めて確認する。
 */
export async function requireAdmin(): Promise<AdminContext> {
  // 設定の有無にかかわらず、必ずリクエスト時に判定する（ビルド時に「未設定」の結果が静的に保存されないように）
  await connection();
  const db = await createSessionClient();
  if (!db) redirect("/login?error=config");
  const check = await resolveAdmin(db);
  switch (check.status) {
    case "admin":
      return { user: check.user, db };
    case "forbidden":
      redirect("/login?error=forbidden");
    case "error":
      redirect("/login?error=unavailable");
    default:
      redirect("/login");
  }
}
