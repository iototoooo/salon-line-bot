import type { ServerClientOptions, ServerSupabaseClient, SupabaseServerConfig } from "./server";

/**
 * line_webhook_events の読み取り専用レポート（scripts/supabase/check-webhook-events.mts から実行）。
 *
 * 実機テスト（LINE → トンネル → ローカル Next.js → Supabase）で、受信したイベントが保存されたか、
 * 処理状態がどうなったかを確認する。書き込み・RPC は行わない（クライアントも readOnly）。
 *
 * 表示するもの：イベント ID・種類・状態・返信状態・エラー概要・時刻・件数
 * 表示しないもの：キーの値（line_webhook_events にはユーザー ID・本文の列がない）
 *
 * このファイルは Node で直接読み込むため、実行時の import を持たない（依存は引数で受け取る）。
 */

export type ReportOptions = {
  /** 受信時刻がこの分数以内のイベントだけを対象にする */
  sinceMinutes: number;
  /** イベント ID の接頭辞で絞り込む */
  prefix?: string;
  /** 一覧に表示する最大件数 */
  limit: number;
  /** 対象イベントの確認・削除用 SQL を出力する（実行はしない） */
  printSql: boolean;
};

export type EventRow = {
  webhook_event_id: string;
  event_type: string;
  is_redelivery: boolean;
  status: string;
  reply_status: string;
  last_error: string | null;
  needs_owner_notification: boolean;
  received_at: string;
  processed_at: string | null;
};

const MAX_ROWS = 500;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
/** 停止とみなす目安（mark_stalled_line_webhook_events の最小値と同じ） */
const STALLED_HINT_MS = 2 * 60_000;

export class ReportArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportArgsError";
  }
}

/** コマンドライン引数を解釈する。--since <分> --prefix <ID 接頭辞> --limit <件数> --sql */
export function parseReportArgs(argv: string[]): ReportOptions {
  const opts: ReportOptions = { sinceMinutes: 60, limit: 30, printSql: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new ReportArgsError(`${a} の値がない`);
      return v;
    };
    if (a === "--since") {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1 || n > 7 * 24 * 60) throw new ReportArgsError("--since は 1〜10080（分）の整数");
      opts.sinceMinutes = n;
    } else if (a === "--limit") {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1 || n > 200) throw new ReportArgsError("--limit は 1〜200 の整数");
      opts.limit = n;
    } else if (a === "--prefix") {
      const p = next();
      // LIKE のワイルドカード（% _）を含めない。英数字とハイフンのみ
      if (!/^[A-Za-z0-9-]{1,100}$/.test(p)) throw new ReportArgsError("--prefix は英数字とハイフンのみ");
      opts.prefix = p;
    } else if (a === "--sql") {
      opts.printSql = true;
    } else {
      throw new ReportArgsError(`不明な引数: ${a}`);
    }
  }
  return opts;
}

const REPLY_LABEL: Record<string, string> = {
  none: "未試行",
  sending: "送信中",
  sent: "LINE が受理（実送信）",
  simulated: "dry-run（未送信）",
  failed: "LINE が拒否",
  unknown: "成否不明",
};

/** ID を指定した確認・削除用 SQL を作る（このスクリプトでは実行しない） */
export function buildCleanupSql(ids: string[]): string {
  const safe = ids.filter((id) => ID_PATTERN.test(id));
  if (safe.length === 0) return "-- 対象のイベントがありません";
  const list = safe.map((id) => `  '${id}'`).join(",\n");
  return [
    `-- 対象 ${safe.length} 件。Supabase SQL Editor で、内容を確認してから実行する`,
    "-- 1. 削除前の確認",
    "select webhook_event_id, event_type, status, reply_status, received_at",
    "from public.line_webhook_events",
    `where webhook_event_id in (\n${list}\n)`,
    "order by received_at;",
    "",
    `-- 2. 削除（結果が ${safe.length} rows であること）`,
    "delete from public.line_webhook_events",
    `where webhook_event_id in (\n${list}\n)`,
    "returning webhook_event_id;",
    "",
    "-- 3. 削除後の確認（0 であること）",
    "select count(*) as remaining from public.line_webhook_events",
    `where webhook_event_id in (\n${list}\n);`,
  ].join("\n");
}

export type ReportDeps = {
  readConfig: (env: NodeJS.ProcessEnv) => SupabaseServerConfig | null;
  createClient: (config: SupabaseServerConfig, options: ServerClientOptions) => ServerSupabaseClient;
  log: (line: string) => void;
  now?: () => number;
};

/** レポートを表示し、終了コード（0: 成功 / 1: 読み取り失敗 / 2: 設定・引数エラー）を返す */
export async function runWebhookEventsReport(
  env: NodeJS.ProcessEnv,
  argv: string[],
  deps: ReportDeps,
): Promise<number> {
  const { log } = deps;
  const now = (deps.now ?? Date.now)();
  log("line_webhook_events の確認（読み取り専用）");

  let opts: ReportOptions;
  let config: SupabaseServerConfig | null;
  try {
    opts = parseReportArgs(argv);
    config = deps.readConfig(env);
  } catch (e) {
    const code = e instanceof Error && "code" in e ? `（${String((e as { code: unknown }).code)}）` : "";
    log(`[NG] 設定・引数エラー${code}: ${e instanceof Error ? e.message : "unknown"}`);
    return 2;
  }
  if (!config) {
    log("[NG] SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を設定してください");
    return 2;
  }

  const since = new Date(now - opts.sinceMinutes * 60_000).toISOString();
  log(`接続先: ${config.url}（Project Ref: ${config.projectRef}）`);
  log(`LINE_REPLY_MODE: ${env.LINE_REPLY_MODE === "live" ? "live（実送信）" : "dry-run"}`);
  log(`対象: 受信が直近 ${opts.sinceMinutes} 分${opts.prefix ? `、ID が ${opts.prefix} で始まる` : ""}`);

  const db = deps.createClient(config, { readOnly: true });
  const total = await db
    .from("line_webhook_events")
    .select("webhook_event_id", { count: "exact", head: true })
    .retry(false);
  let query = db
    .from("line_webhook_events")
    .select(
      "webhook_event_id, event_type, is_redelivery, status, reply_status, last_error, needs_owner_notification, received_at, processed_at",
    )
    .gte("received_at", since);
  if (opts.prefix) query = query.like("webhook_event_id", `${opts.prefix}%`);
  const result = await query.order("received_at", { ascending: false }).limit(MAX_ROWS).retry(false);

  if (total.error || result.error || !result.data) {
    const status = result.error ? result.status : total.status;
    const code = (result.error ?? total.error)?.code;
    log(`[NG] 読み取りに失敗しました（status=${status || "-"}${code ? `, code=${code}` : ""}）`);
    return 1;
  }

  const rows = result.data as EventRow[];
  log(`テーブル全体: ${total.count ?? "?"} 件 / 対象: ${rows.length} 件${rows.length >= MAX_ROWS ? `（上限 ${MAX_ROWS} 件まで表示）` : ""}`);

  const tally = new Map<string, number>();
  for (const r of rows) tally.set(`${r.status} / ${r.reply_status}`, (tally.get(`${r.status} / ${r.reply_status}`) ?? 0) + 1);
  for (const [k, n] of [...tally.entries()].sort()) {
    const reply = k.split(" / ")[1];
    log(`  ${k}（${REPLY_LABEL[reply] ?? reply}）: ${n} 件`);
  }

  const stalled = rows.filter((r) => r.status === "processing" && now - Date.parse(r.received_at) > STALLED_HINT_MS);
  if (stalled.length > 0) log(`[注意] 2 分以上 processing のままのイベント: ${stalled.length} 件（処理が途中で止まった可能性）`);
  const sentInDryRun = env.LINE_REPLY_MODE !== "live" ? rows.filter((r) => r.reply_status === "sent").length : 0;
  if (sentInDryRun > 0) log(`[注意] dry-run 設定ですが、実送信（sent）のイベントが ${sentInDryRun} 件あります`);
  const notify = rows.filter((r) => r.needs_owner_notification).length;
  if (notify > 0) log(`[情報] 要通知のイベント: ${notify} 件`);

  log("");
  log("受信時刻（UTC）           | イベント ID | 種類 | 再送 | 状態 / 返信 | エラー概要");
  for (const r of rows.slice(0, opts.limit)) {
    log(
      [
        r.received_at,
        r.webhook_event_id,
        r.event_type,
        r.is_redelivery ? "再送" : "-",
        `${r.status} / ${r.reply_status}`,
        r.last_error ?? "-",
      ].join(" | "),
    );
  }
  if (rows.length > opts.limit) log(`…ほか ${rows.length - opts.limit} 件（--limit で変更）`);

  if (opts.printSql) {
    log("");
    log("---- 確認・削除用 SQL（このスクリプトは実行しない） ----");
    log(buildCleanupSql(rows.map((r) => r.webhook_event_id)));
  }
  return 0;
}
