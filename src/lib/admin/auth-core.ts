import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * 管理者の判定（Next.js に依存しない部分。テスト対象）。
 *
 * 1. Supabase Auth にログイン中のユーザーを問い合わせる（getUser：Auth サーバーでトークンを検証する。
 *    Cookie の中身だけを信用する getSession は使わない）
 * 2. admin_users にそのユーザーがいるかを、ログイン中のセッション（RLS）で確認する
 *    （admin_users の参照ポリシーは「管理者本人のみ」なので、管理者でなければ 0 件になる）
 */
export type SessionClient = SupabaseClient<Database>;

export type AdminUser = {
  id: string;
  /** 画面のヘッダーに表示する（ログに出さない） */
  email: string | null;
};

export type AdminCheck =
  | { status: "admin"; user: AdminUser }
  | { status: "unauthenticated" }
  | { status: "forbidden" }
  | { status: "error" };

export async function resolveAdmin(client: SessionClient): Promise<AdminCheck> {
  let userId: string;
  let email: string | null;
  try {
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return { status: "unauthenticated" };
    userId = data.user.id;
    email = data.user.email ?? null;
  } catch {
    return { status: "unauthenticated" };
  }

  const { data, error } = await client.from("admin_users").select("user_id").eq("user_id", userId).maybeSingle();
  if (error) return { status: "error" };
  if (!data) return { status: "forbidden" };
  return { status: "admin", user: { id: userId, email } };
}

/** ログイン後の移動先。外部サイトへのリダイレクト（オープンリダイレクト）を防ぐため、/admin 配下だけを許可する */
export function safeAdminPath(next: unknown): string {
  if (typeof next !== "string") return "/admin";
  if (!/^\/admin(\/[A-Za-z0-9/_-]*)?(\?[A-Za-z0-9=&_-]*)?$/.test(next)) return "/admin";
  if (next.includes("//")) return "/admin";
  return next;
}
