import { type ActionState, fail } from "./action-state";
import { resolveAdmin, safeAdminPath, type SessionClient } from "./auth-core";

/**
 * ログイン処理の本体（Next.js に依存しない部分。テスト対象）。
 * - 失敗の理由（メールが存在しない・パスワード違い・管理者でない）は区別して表示しない（アカウントの存在を推測させない）
 * - 管理者でない場合は、作られたセッションを直ちに破棄する
 * - 成功時の移動先は /admin 配下に限定する
 */
export const LOGIN_FAILED = "メールアドレスまたはパスワードが正しくありません。";
export const LOGIN_UNAVAILABLE = "ログインできませんでした。時間をおいて再度お試しください。";

export type LoginResult = { kind: "redirect"; to: string } | { kind: "state"; state: ActionState };

export async function login(client: SessionClient | null, formData: FormData): Promise<LoginResult> {
  if (!client) return { kind: "state", state: fail("ログインの設定がされていません（管理者に連絡してください）。") };

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password || email.length > 254 || password.length > 200) {
    return { kind: "state", state: fail("メールアドレスとパスワードを入力してください。") };
  }

  try {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) return { kind: "state", state: fail(LOGIN_FAILED) };
  } catch {
    return { kind: "state", state: fail(LOGIN_UNAVAILABLE) };
  }

  const check = await resolveAdmin(client);
  if (check.status !== "admin") {
    await client.auth.signOut().catch(() => undefined);
    return { kind: "state", state: fail(check.status === "error" ? LOGIN_UNAVAILABLE : LOGIN_FAILED) };
  }
  return { kind: "redirect", to: safeAdminPath(formData.get("next")) };
}
