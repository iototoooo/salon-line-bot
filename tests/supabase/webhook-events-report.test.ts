import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCleanupSql,
  parseReportArgs,
  ReportArgsError,
  runWebhookEventsReport,
} from "@/lib/supabase/webhook-events-report";
import { createServerSupabaseClient, readSupabaseServerConfig, SUPABASE_PROJECT_REF } from "@/lib/supabase/server";

// 実在しないダミー値。実際の Supabase には接続しない（fetch はすべてスタブ）
const URL_OK = `https://${SUPABASE_PROJECT_REF}.supabase.co`;
const SECRET = "sb_secret_DUMMYdummyDUMMYdummy0123";
const ENV = { SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: SECRET, LINE_REPLY_MODE: "dry-run" } as unknown as NodeJS.ProcessEnv;
const NOW = Date.parse("2026-11-11T06:00:00Z");

const row = (id: string, over: Record<string, unknown> = {}) => ({
  webhook_event_id: id,
  event_type: "message",
  is_redelivery: false,
  status: "done",
  reply_status: "simulated",
  last_error: null,
  needs_owner_notification: false,
  received_at: "2026-11-11T05:59:00+00:00",
  processed_at: "2026-11-11T05:59:01+00:00",
  ...over,
});

async function runWith(rows: unknown[], argv: string[] = [], env = ENV, status = 200) {
  const requests: Array<{ method: string; url: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push({ method, url: String(input) });
      if (status !== 200) return new Response(JSON.stringify({ code: "42501", message: "denied" }), { status });
      return new Response(method === "HEAD" ? null : JSON.stringify(rows), {
        status: 200,
        headers: { "content-type": "application/json", "content-range": `0-${rows.length - 1}/${rows.length + 3}` },
      });
    }),
  );
  const logs: string[] = [];
  const code = await runWebhookEventsReport(env, argv, {
    readConfig: readSupabaseServerConfig,
    createClient: createServerSupabaseClient,
    log: (l) => logs.push(l),
    now: () => NOW,
  });
  return { code, text: logs.join("\n"), requests };
}

afterEach(() => vi.unstubAllGlobals());

describe("parseReportArgs", () => {
  it("既定値と各オプション", () => {
    expect(parseReportArgs([])).toEqual({ sinceMinutes: 60, limit: 30, printSql: false });
    expect(parseReportArgs(["--since", "15", "--prefix", "01ABC-x", "--limit", "5", "--sql"])).toEqual({
      sinceMinutes: 15,
      prefix: "01ABC-x",
      limit: 5,
      printSql: true,
    });
  });

  it.each([
    [["--since", "0"]],
    [["--since", "abc"]],
    [["--limit", "1000"]],
    [["--prefix", "test%"]],
    [["--prefix", "a_b"]],
    [["--prefix"]],
    [["--unknown"]],
  ])("不正な引数 %j はエラー", (argv) => {
    expect(() => parseReportArgs(argv)).toThrow(ReportArgsError);
  });
});

describe("runWebhookEventsReport（fetch はスタブ・実接続なし）", () => {
  it("GET と件数用の HEAD だけを送り、書き込み・RPC は送らない", async () => {
    const r = await runWith([row("01EVENTA")], ["--prefix", "01EVENT", "--since", "30"]);
    expect(r.code).toBe(0);
    expect(r.requests.map((q) => q.method).sort()).toEqual(["GET", "HEAD"]);
    expect(r.requests.every((q) => q.url.startsWith(`${URL_OK}/rest/v1/line_webhook_events?`))).toBe(true);
    const get = r.requests.find((q) => q.method === "GET")!;
    expect(decodeURIComponent(get.url)).toContain("webhook_event_id=like.01EVENT%");
    expect(decodeURIComponent(get.url)).toContain("received_at=gte.2026-11-11T05:30:00.000Z");
  });

  it("件数・状態の内訳・一覧を表示し、dry-run を未送信と表示する", async () => {
    const r = await runWith([row("01EVENTA"), row("01EVENTB", { status: "skipped", reply_status: "none", event_type: "follow" })]);
    expect(r.text).toContain(`接続先: ${URL_OK}（Project Ref: ${SUPABASE_PROJECT_REF}）`);
    expect(r.text).toContain("テーブル全体: 5 件 / 対象: 2 件");
    expect(r.text).toContain("done / simulated（dry-run（未送信））: 1 件");
    expect(r.text).toContain("skipped / none（未試行）: 1 件");
    expect(r.text).toContain("01EVENTA | message | - | done / simulated | -");
  });

  it("停止の疑い・dry-run 中の sent・要通知を注意として表示する", async () => {
    const r = await runWith([
      row("01OLD", { status: "processing", reply_status: "sending", processed_at: null, received_at: "2026-11-11T05:50:00+00:00" }),
      row("01SENT", { reply_status: "sent" }),
      row("01NOTIFY", { status: "failed", reply_status: "failed", last_error: "reply_failed", needs_owner_notification: true }),
    ]);
    expect(r.text).toContain("[注意] 2 分以上 processing のままのイベント: 1 件");
    expect(r.text).toContain("[注意] dry-run 設定ですが、実送信（sent）のイベントが 1 件あります");
    expect(r.text).toContain("[情報] 要通知のイベント: 1 件");
  });

  it("--sql で ID を指定した確認・削除用 SQL を表示する（実行はしない）", async () => {
    const r = await runWith([row("01EVENTA"), row("01EVENTB")], ["--sql"]);
    expect(r.text).toContain("delete from public.line_webhook_events");
    expect(r.text).toContain("'01EVENTA'");
    expect(r.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
  });

  it("読み取りに失敗したら終了コード 1。エラー本文は表示しない", async () => {
    const r = await runWith([], [], ENV, 403);
    expect(r.code).toBe(1);
    expect(r.text).toContain("[NG] 読み取りに失敗しました（status=403, code=42501）");
    expect(r.text).not.toContain("denied");
  });

  it.each([
    ["未設定", {}, []],
    ["別プロジェクトの URL", { SUPABASE_URL: "https://otherprojectaaaaaaaaa.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SECRET }, []],
    ["不正な引数", ENV, ["--prefix", "x%"]],
  ])("%s → 終了コード 2、リクエストは送らない", async (_l, env, argv) => {
    const r = await runWith([], argv as string[], env as unknown as NodeJS.ProcessEnv);
    expect(r.code).toBe(2);
    expect(r.requests).toEqual([]);
  });

  it("どの場合もログにキーの値が含まれない", async () => {
    for (const r of [await runWith([row("01A")], ["--sql"]), await runWith([], [], ENV, 403)]) {
      expect(r.text).not.toContain(SECRET);
    }
  });
});

describe("buildCleanupSql", () => {
  it("ID の形式に合わないものは SQL に含めない（SQL インジェクション防止）", () => {
    const sql = buildCleanupSql(["01GOOD", "bad'; drop table x; --"]);
    expect(sql).toContain("'01GOOD'");
    expect(sql).not.toContain("drop table");
    expect(sql).toContain("対象 1 件");
  });

  it("対象がなければ SQL を出さない", () => {
    expect(buildCleanupSql([])).toBe("-- 対象のイベントがありません");
  });
});
