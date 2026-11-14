import { classifySupabaseKey, SUPABASE_PROJECT_HOST, SupabaseConfigError } from "./server";

/**
 * 管理画面のログイン（Supabase Auth）に使う公開用の接続設定。
 *
 * - NEXT_PUBLIC_SUPABASE_URL：本案件のプロジェクト（https://dnortggovlwgcdeoadbf.supabase.co）だけを許可
 * - NEXT_PUBLIC_SUPABASE_ANON_KEY：publishable key（sb_publishable_…）または legacy の anon キーだけを許可。
 *   secret key・service_role キーは拒否する（ブラウザに配布される変数のため）
 * - 未設定なら null（管理画面はログインできない状態で表示し、DB には接続しない）
 *
 * 管理画面のデータ操作は、このキー＋ログイン中のセッション（authenticated ロール・RLS 適用）で行う。
 */
export type SupabasePublicConfig = { url: string; publishableKey: string };

/**
 * ブラウザ自動テスト（e2e/）専用：ローカルの偽の Supabase（http://127.0.0.1:<port>）への接続を許可する。
 * NODE_ENV=test のときだけ有効（next build・本番は常に production のため、本番では有効にならない）。
 * 偽のサーバーは PGlite で動き、本番の Supabase には接続しない。
 */
export function readE2eFakeSupabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV !== "test") return null;
  const v = (env.E2E_FAKE_SUPABASE_URL ?? "").trim();
  return /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(v) ? v : null;
}

export function readSupabasePublicConfig(env: NodeJS.ProcessEnv = process.env): SupabasePublicConfig | null {
  const url = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const key = (env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
  if (!url || !key) return null;

  const fake = readE2eFakeSupabaseUrl(env);
  if (fake !== null && url === fake) {
    if (!key.startsWith("sb_publishable_E2E")) {
      throw new SupabaseConfigError("E2E tests must use the dummy publishable key (sb_publishable_E2E...)", "unknown_key_format");
    }
    return { url: fake, publishableKey: key };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SupabaseConfigError("NEXT_PUBLIC_SUPABASE_URL must be a valid URL", "invalid_url");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== SUPABASE_PROJECT_HOST ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new SupabaseConfigError(
      `NEXT_PUBLIC_SUPABASE_URL must be https://${SUPABASE_PROJECT_HOST} (got host "${parsed.hostname}")`,
      "url_mismatch",
    );
  }

  if (/[\s"']/.test(key)) {
    throw new SupabaseConfigError("NEXT_PUBLIC_SUPABASE_ANON_KEY contains whitespace or quotes", "key_has_whitespace");
  }
  const { kind, ref } = classifySupabaseKey(key);
  if (kind === "secret" || kind === "legacy_service_role" || key.startsWith("sb_secret_")) {
    throw new SupabaseConfigError(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY contains a server-only secret key. Remove it immediately and rotate the key",
      "secret_in_public_env",
    );
  }
  if (kind === "legacy_anon" && ref !== undefined && ref !== SUPABASE_PROJECT_HOST.split(".")[0]) {
    throw new SupabaseConfigError("NEXT_PUBLIC_SUPABASE_ANON_KEY is an anon key for a different project", "legacy_key_ref_mismatch");
  }
  if (kind !== "publishable" && kind !== "legacy_anon") {
    throw new SupabaseConfigError(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY must be a publishable key (sb_publishable_...)",
      "unknown_key_format",
    );
  }
  return { url: `https://${SUPABASE_PROJECT_HOST}`, publishableKey: key };
}
