import { vi } from "vitest";
import type { SessionClient } from "@/lib/admin/auth-core";

/**
 * テスト用のログインセッション（Supabase Auth と admin_users の参照だけを再現する）。
 * 実際の Supabase には接続しない。
 */
export const ADMIN_ID = "11111111-1111-4111-8111-111111111111";

export function fakeSession(opts: {
  user?: { id: string; email?: string } | null;
  getUserError?: boolean;
  isAdmin?: boolean;
  adminQueryError?: boolean;
  signInError?: boolean;
  signInThrows?: boolean;
} = {}) {
  const user = opts.user === undefined ? { id: ADMIN_ID, email: "owner@example.com" } : opts.user;
  const signInWithPassword = vi.fn(async () => {
    if (opts.signInThrows) throw new Error("network");
    return { data: {}, error: opts.signInError ? { message: "Invalid login credentials" } : null };
  });
  const signOut = vi.fn(async () => ({ error: null }));
  const getUser = vi.fn(async () =>
    opts.getUserError || !user
      ? { data: { user: null }, error: { message: "no session" } }
      : { data: { user: { id: user.id, email: user.email } }, error: null },
  );
  const eq = vi.fn(() => ({
    maybeSingle: async () =>
      opts.adminQueryError
        ? { data: null, error: { code: "42501", message: "x" } }
        : { data: opts.isAdmin === false ? null : { user_id: user?.id }, error: null },
  }));
  const from = vi.fn(() => ({ select: vi.fn(() => ({ eq })) }));
  const client = { auth: { getUser, signInWithPassword, signOut }, from } as unknown as SessionClient;
  return { client, getUser, signInWithPassword, signOut, from };
}
