import type {
  ServerClientOptions,
  ServerSupabaseClient,
  SupabaseConfigError,
  SupabaseServerConfig,
} from "./server";

/**
 * Supabase への読み取り専用の接続確認（scripts/supabase/check-connection.mts から実行）。
 *
 * 行うこと：SUPABASE_URL とキーの組み合わせで shop_settings（id, bot_enabled のみ）を読む。
 *   - 読めた ＝ URL のプロジェクト（Ref）と、そのプロジェクトのキーで接続できた
 *     （別プロジェクトのキーは Supabase の API ゲートウェイで拒否される）
 *   - 初期行（id = 1）が 1 行だけあり、bot_enabled = false であること
 * 行わないこと：INSERT・UPDATE・DELETE・RPC（クライアント側でも GET 以外を拒否する）
 *
 * 出力にはキーの値・エラーメッセージの本文を含めない（分類・コード・HTTP ステータスのみ）。
 * このファイルは Node で直接読み込むため、実行時の import を持たない（依存は引数で受け取る）。
 */

export type FailureCategory =
  | "config" // 環境変数の誤り・未設定
  | "network" // 名前解決・接続の失敗
  | "timeout" // 応答なし
  | "auth" // キーが無効、または別プロジェクトのキー
  | "permission" // キーは有効だが権限がない（GRANT 不足など）
  | "schema" // テーブルがない（マイグレーション未適用）
  | "unexpected_data" // 接続は成功したが内容が想定外
  | "unknown";

export type CheckLine = { label: string; ok: boolean; detail?: string };

export type ConnectionReport = {
  ok: boolean;
  lines: CheckLine[];
  failure?: { category: FailureCategory; code?: string; status?: number };
};

type DbErrorLike = { code?: unknown; message?: unknown } | null | undefined;

const CATEGORY_HINTS: Record<FailureCategory, string> = {
  config: ".env.local の SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を確認してください",
  network: "ネットワーク接続、または SUPABASE_URL のホスト名を確認してください",
  timeout: "Supabase が応答しませんでした。プロジェクトの状態（一時停止など）を確認してください",
  auth: "キーが無効か、別のプロジェクトのキーです。ダッシュボードで salon-line-bot の secret key を確認してください",
  permission: "キーは有効ですが権限がありません。service_role の GRANT（3 本目のマイグレーション）を確認してください",
  schema: "shop_settings テーブルが見つかりません。マイグレーションの適用状況を確認してください",
  unexpected_data: "接続は成功しましたが、データが想定と異なります",
  unknown: "想定外のエラーです。コードとステータスを確認してください",
};

/** supabase-js のエラーと HTTP ステータスを原因ごとに分類する（メッセージ本文は返さない） */
export function classifyDbError(error: DbErrorLike, status: number | undefined): {
  category: FailureCategory;
  code?: string;
} {
  const code = typeof error?.code === "string" && /^[A-Za-z0-9_]{1,20}$/.test(error.code) ? error.code : undefined;
  const message = typeof error?.message === "string" ? error.message : "";
  if (/timeout|aborted/i.test(message) || code === "57014") return { category: "timeout", code };
  if (status === 401 || code === "PGRST301" || code === "PGRST302" || /invalid api key|jwt/i.test(message)) {
    return { category: "auth", code };
  }
  if (status === 403 || code === "42501") return { category: "permission", code };
  if (status === 404 || code === "PGRST205" || code === "42P01") return { category: "schema", code };
  if (!status || /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|network/i.test(message)) {
    return { category: "network", code };
  }
  return { category: "unknown", code };
}

/** shop_settings を読み、初期行と自動応答 OFF を確認する（読み取りのみ） */
export async function verifyShopSettings(db: ServerSupabaseClient): Promise<ConnectionReport> {
  let result: { data: Array<{ id: number; bot_enabled: boolean }> | null; error: DbErrorLike; status: number };
  try {
    // retry(false)：postgrest-js は GET の通信エラーを最大 3 回（1・2・4 秒後）再試行するため、
    // 接続確認では再試行せずにすぐ原因を表示する
    result = await db.from("shop_settings").select("id, bot_enabled").retry(false);
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const category: FailureCategory = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
    return { ok: false, lines: [{ label: "shop_settings の読み取り", ok: false }], failure: { category } };
  }

  if (result.error || !result.data) {
    const { category, code } = classifyDbError(result.error, result.status);
    return {
      ok: false,
      lines: [{ label: "shop_settings の読み取り", ok: false, detail: `HTTP ${result.status || "-"}` }],
      failure: { category, code, status: result.status || undefined },
    };
  }

  const rows = result.data;
  const lines: CheckLine[] = [{ label: "shop_settings の読み取り", ok: true, detail: `HTTP ${result.status}` }];
  const single = rows.length === 1 && rows[0].id === 1;
  lines.push({ label: "初期行（id = 1）が 1 行だけある", ok: single, detail: `${rows.length} 行` });
  const botOff = single && rows[0].bot_enabled === false;
  lines.push({
    label: "自動応答が OFF（bot_enabled = false）",
    ok: botOff,
    detail: single ? `bot_enabled = ${rows[0].bot_enabled}` : "初期行がないため判定できない",
  });
  const ok = single && botOff;
  return ok ? { ok, lines } : { ok, lines, failure: { category: "unexpected_data" } };
}

export type ConnectionCheckDeps = {
  readConfig: (env: NodeJS.ProcessEnv) => SupabaseServerConfig | null;
  createClient: (config: SupabaseServerConfig, options: ServerClientOptions) => ServerSupabaseClient;
  log: (line: string) => void;
};

const KEY_KIND_LABEL: Record<SupabaseServerConfig["keyKind"], string> = {
  secret: "secret key（sb_secret_…・新形式）",
  legacy_service_role: "legacy service_role キー（JWT・予備）",
};

const isConfigError = (e: unknown): e is SupabaseConfigError =>
  e instanceof Error && e.name === "SupabaseConfigError";

/** 接続確認を実行し、結果を表示して終了コード（0: 合格 / 1: 不合格 / 2: 設定エラー）を返す */
export async function runConnectionCheck(env: NodeJS.ProcessEnv, deps: ConnectionCheckDeps): Promise<number> {
  const { log } = deps;
  log("Supabase 接続確認（読み取り専用）");

  let config: SupabaseServerConfig | null;
  try {
    config = deps.readConfig(env);
  } catch (e) {
    if (isConfigError(e)) {
      log(`[NG] 設定エラー（${e.code}）: ${e.message}`);
    } else {
      log("[NG] 設定の読み込みで想定外のエラー");
    }
    log(`対処: ${CATEGORY_HINTS.config}`);
    return 2;
  }
  if (!config) {
    log("[NG] 設定エラー（missing）: SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を設定してください");
    log(`対処: ${CATEGORY_HINTS.config}`);
    return 2;
  }

  log(`接続先: ${config.url}（Project Ref: ${config.projectRef}）`);
  log(`キーの種類: ${KEY_KIND_LABEL[config.keyKind]}`);

  let report: ConnectionReport;
  try {
    report = await verifyShopSettings(deps.createClient(config, { readOnly: true }));
  } catch {
    report = { ok: false, lines: [], failure: { category: "unknown" } };
  }

  for (const line of report.lines) {
    log(`[${line.ok ? "OK" : "NG"}] ${line.label}${line.detail ? `（${line.detail}）` : ""}`);
  }
  if (report.ok) {
    log(`結果: 合格。Project Ref ${config.projectRef} に、このキーで読み取り接続できました`);
    return 0;
  }
  const f = report.failure ?? { category: "unknown" as const };
  const extra = [f.code ? `code=${f.code}` : "", f.status ? `status=${f.status}` : ""].filter(Boolean).join(", ");
  log(`結果: 不合格（${f.category}${extra ? `: ${extra}` : ""}）`);
  log(`対処: ${CATEGORY_HINTS[f.category]}`);
  return 1;
}
