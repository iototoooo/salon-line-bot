import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * サーバー専用の Supabase クライアント（secret キー）。
 *
 * - RLS をバイパスするため、Route Handler・Server Action など**サーバー側のコードからのみ**使う
 * - クライアントコンポーネント（"use client"）から import しないこと
 * - キーは NEXT_PUBLIC_ を付けない環境変数 SUPABASE_SERVICE_ROLE_KEY で管理し、ブラウザに渡さない
 *
 * このファイルは scripts/supabase/check-connection.mts からも Node で直接読み込むため、
 * 実行時に必要な import は外部パッケージだけにする（@/ のパス別名は型の import のみ可）。
 */
export type ServerSupabaseClient = SupabaseClient<Database>;

/** 本案件の Supabase プロジェクト。これ以外の URL には接続しない */
export const SUPABASE_PROJECT_REF = "dnortggovlwgcdeoadbf";
export const SUPABASE_PROJECT_HOST = `${SUPABASE_PROJECT_REF}.supabase.co`;

/** 受け付けるサーバー用キー。新形式の secret キーを基本とし、legacy の service_role JWT は予備として許可する */
export type SupabaseServerKeyKind = "secret" | "legacy_service_role";

export type SupabaseServerConfig = {
  url: string;
  serviceRoleKey: string;
  projectRef: string;
  keyKind: SupabaseServerKeyKind;
};

export type SupabaseConfigErrorCode =
  | "invalid_url"
  | "url_mismatch"
  | "key_has_whitespace"
  | "publishable_key"
  | "legacy_anon_key"
  | "legacy_key_ref_mismatch"
  | "unknown_key_format"
  | "secret_in_public_env"
  | "invalid_setting";

/** 設定の誤り。メッセージには変数名と理由だけを含め、値（URL 以外）は含めない */
export class SupabaseConfigError extends Error {
  readonly code: SupabaseConfigErrorCode;
  constructor(message: string, code: SupabaseConfigErrorCode = "invalid_setting") {
    super(message);
    this.name = "SupabaseConfigError";
    this.code = code;
  }
}

export type SupabaseKeyKind =
  | "secret"
  | "publishable"
  | "legacy_service_role"
  | "legacy_anon"
  | "legacy_other"
  | "unknown";

const SECRET_KEY_PATTERN = /^sb_secret_[A-Za-z0-9_-]{10,}$/;
const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * キーの種類を判定する。値はどこにも出力しない。
 * - 新形式（sb_secret_ / sb_publishable_）は JWT ではないため、接頭辞だけで判定する（JWT として解析しない）
 * - legacy キー（JWT 形式）だけペイロードの role と ref を読む。署名は検証しない（検証は Supabase 側が行う）
 */
export function classifySupabaseKey(key: string): { kind: SupabaseKeyKind; ref?: string } {
  if (key.startsWith("sb_secret_")) return { kind: SECRET_KEY_PATTERN.test(key) ? "secret" : "unknown" };
  if (key.startsWith("sb_publishable_")) return { kind: "publishable" };
  if (key.startsWith("sb_")) return { kind: "unknown" };
  if (!JWT_PATTERN.test(key)) return { kind: "unknown" };
  try {
    const payload = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")) as {
      role?: unknown;
      ref?: unknown;
    };
    const ref = typeof payload.ref === "string" ? payload.ref : undefined;
    if (payload.role === "service_role") return { kind: "legacy_service_role", ref };
    if (payload.role === "anon") return { kind: "legacy_anon", ref };
    return { kind: "legacy_other", ref };
  } catch {
    return { kind: "unknown" };
  }
}

/** NEXT_PUBLIC_ の環境変数（ブラウザに配布される）に秘密キーが入っていないか */
function assertNoSecretInPublicEnv(env: NodeJS.ProcessEnv) {
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("NEXT_PUBLIC_") || !value) continue;
    const kind = classifySupabaseKey(value.trim()).kind;
    if (kind === "secret" || kind === "legacy_service_role" || value.trim().startsWith("sb_secret_")) {
      throw new SupabaseConfigError(
        `${name} contains a server-only secret key. Remove it immediately and rotate the key`,
        "secret_in_public_env",
      );
    }
  }
}

function validateUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SupabaseConfigError("SUPABASE_URL must start with http:// or https://", "invalid_url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SupabaseConfigError("SUPABASE_URL must start with http:// or https://", "invalid_url");
  }
  const isTarget =
    parsed.protocol === "https:" &&
    parsed.hostname === SUPABASE_PROJECT_HOST &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    (parsed.pathname === "/" || parsed.pathname === "") &&
    parsed.search === "" &&
    parsed.hash === "";
  if (!isTarget) {
    // URL は秘密情報ではないが、念のためホスト名だけを示す
    throw new SupabaseConfigError(
      `SUPABASE_URL must be https://${SUPABASE_PROJECT_HOST} (got host "${parsed.hostname}")`,
      "url_mismatch",
    );
  }
  return `https://${SUPABASE_PROJECT_HOST}`;
}

function validateServerKey(key: string): SupabaseServerKeyKind {
  if (key !== key.trim() || /[\s"']/.test(key)) {
    throw new SupabaseConfigError(
      "SUPABASE_SERVICE_ROLE_KEY contains whitespace or quotes (check for copy-and-paste mistakes)",
      "key_has_whitespace",
    );
  }
  const { kind, ref } = classifySupabaseKey(key);
  switch (kind) {
    case "secret":
      return "secret";
    case "legacy_service_role":
      if (ref !== SUPABASE_PROJECT_REF) {
        throw new SupabaseConfigError(
          "SUPABASE_SERVICE_ROLE_KEY is a legacy service_role key for a different project",
          "legacy_key_ref_mismatch",
        );
      }
      return "legacy_service_role";
    case "publishable":
      throw new SupabaseConfigError(
        "SUPABASE_SERVICE_ROLE_KEY must be a secret key (sb_secret_...), not a publishable key",
        "publishable_key",
      );
    case "legacy_anon":
      throw new SupabaseConfigError(
        "SUPABASE_SERVICE_ROLE_KEY must be a secret key (sb_secret_...), not the legacy anon key",
        "legacy_anon_key",
      );
    default:
      throw new SupabaseConfigError(
        "SUPABASE_SERVICE_ROLE_KEY has an unrecognized format (expected sb_secret_...)",
        "unknown_key_format",
      );
  }
}

/**
 * 環境変数から接続設定を読み、検証する。URL かキーが未設定なら null（開発時はメモリ実装に切り替わる）。
 * 誤った設定（別プロジェクトの URL、公開用キー、NEXT_PUBLIC_ への秘密キー混入など）は SupabaseConfigError。
 */
export function readSupabaseServerConfig(env: NodeJS.ProcessEnv = process.env): SupabaseServerConfig | null {
  assertNoSecretInPublicEnv(env);
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !serviceRoleKey) return null;
  const normalizedUrl = validateUrl(url);
  const keyKind = validateServerKey(serviceRoleKey);
  return { url: normalizedUrl, serviceRoleKey, projectRef: SUPABASE_PROJECT_REF, keyKind };
}

const DB_TIMEOUT_MS = 5_000;
const READ_ONLY_METHODS = new Set(["GET", "HEAD"]);

export type ServerClientOptions = {
  /** true なら GET / HEAD 以外のリクエスト（書き込み・RPC）を送信前に拒否する。接続確認用 */
  readOnly?: boolean;
};

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

/**
 * supabase-js が組み立てたリクエストを送る前に調整する fetch。
 * - 新形式のキー（非 JWT）は apikey ヘッダーだけで送る。Authorization: Bearer にキーを入れない
 *   （supabase-js 2.119 は REST では apikey と同じ値を Bearer にも入れるため、ここで取り除く）
 * - タイムアウト（DB が応答しないまま Webhook の応答や返信期限を過ぎないように）
 * - readOnly のときは書き込みを拒否
 */
function createServerFetch(config: SupabaseServerConfig, options: ServerClientOptions): typeof fetch {
  return async (input, init) => {
    if (options.readOnly && !READ_ONLY_METHODS.has(methodOf(input, init))) {
      throw new Error("read-only Supabase client: write requests are not allowed");
    }
    const headers = new Headers(init?.headers);
    if (config.keyKind === "secret" && headers.get("Authorization") === `Bearer ${config.serviceRoleKey}`) {
      headers.delete("Authorization");
    }
    return fetch(input, { ...init, headers, signal: init?.signal ?? AbortSignal.timeout(DB_TIMEOUT_MS) });
  };
}

let cached: { key: string; client: ServerSupabaseClient } | undefined;

export function createServerSupabaseClient(
  config: SupabaseServerConfig,
  options: ServerClientOptions = {},
): ServerSupabaseClient {
  const cacheKey = `${config.url}\n${config.serviceRoleKey}`;
  if (!options.readOnly && cached?.key === cacheKey) return cached.client;
  const client = createClient<Database>(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { "x-client-info": "salon-line-bot-server" },
      fetch: createServerFetch(config, options),
    },
  });
  if (!options.readOnly) cached = { key: cacheKey, client };
  return client;
}
