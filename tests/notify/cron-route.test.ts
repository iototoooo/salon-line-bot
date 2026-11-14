import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "@/app/api/cron/owner-notify/route";
import { MIN_CRON_SECRET_LENGTH } from "@/lib/notify/cron";
import { SUPABASE_PROJECT_REF } from "@/lib/supabase/server";

/**
 * 定期実行（Vercel Schedules → /api/cron/owner-notify）の設定と、環境変数による認証・無効化を確認する。
 * 実際の Supabase・LINE には接続しない（fetch はスタブして、呼ばれた宛先を確認する）。
 *
 * Vercel Hobby（無料）の制約（公式ドキュメント 2026-11-13 確認）
 *   - Cron Jobs（crons）は 1 日 1 回まで（それより頻繁な式はデプロイが失敗する）
 *   - Schedules（schedules・ベータ）は最短 15 分ごと・15 分の幅で実行・1 か月 5,000 回まで（超えると実行されない）
 */

const ROOT = process.cwd();
const vercelJsonText = readFileSync(join(ROOT, "vercel.json"), "utf8");
type ScheduleEntry = { schedule: string; path?: string; requestMethod?: string; jitter?: number; timezone?: string; function?: string; topic?: string };
const vercelJson = JSON.parse(vercelJsonText) as {
  crons?: unknown;
  schedules?: Record<string, ScheduleEntry>;
  functions?: unknown;
  env?: unknown;
  build?: unknown;
};
const HOBBY_MIN_INTERVAL_MINUTES = 15;
const HOBBY_RUNS_PER_MONTH = 5_000;

// テスト専用のダミー値（実在しない）
const SECRET = "t".repeat(MIN_CRON_SECRET_LENGTH);
const SUPABASE = {
  SUPABASE_URL: `https://${SUPABASE_PROJECT_REF}.supabase.co`,
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_DUMMYdummyDUMMYdummy0123",
};
const ENV_KEYS = [
  "CRON_SECRET",
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "WEBHOOK_EVENT_STORE",
  "LINE_REPLY_MODE",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "VERCEL_ENV",
];

const request = (auth?: string) =>
  new Request("https://example.invalid/api/cron/owner-notify", {
    headers: auth === undefined ? {} : { authorization: auth },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // 実行環境の値に左右されないよう、関係する環境変数をすべて空にしてから必要なものだけ設定する
  for (const k of ENV_KEYS) vi.stubEnv(k, "");
  fetchMock = vi.fn(async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("vercel.json の定期実行の設定（Vercel Hobby 対応）", () => {
  it("Schedules に 2 つだけ登録する：オーナー通知（15 分ごと）と保持期間の削除（毎日 03:17 JST = 18:17 UTC）。どちらも GET・既存のルート", () => {
    expect(vercelJson.schedules).toEqual({
      "owner-notify": { schedule: "*/15 * * * *", path: "/api/cron/owner-notify", requestMethod: "GET" },
      retention: { schedule: "17 18 * * *", path: "/api/cron/retention", requestMethod: "GET" },
    });
  });

  it("Cron Jobs（crons）は使わない（Hobby では 1 日 1 回までで、5 分ごとの式はデプロイが失敗する。併用すると 2 回呼ばれる）", () => {
    expect(vercelJson.crons).toBeUndefined();
  });

  it("Hobby の制約を満たす：15 分以上の間隔・jitter は指定しない（Hobby は常に 15 分）・合計で 1 か月 5,000 回以内", () => {
    let perMonth = 0;
    for (const s of Object.values(vercelJson.schedules ?? {})) {
      const [min, hour, dom, mon, dow] = s.schedule.split(" ");
      expect([dom, mon, dow]).toEqual(["*", "*", "*"]);
      if (hour === "*") {
        // n 分ごと
        const step = Number(/^\*\/(\d+)$/.exec(min)?.[1]);
        expect(step).toBeGreaterThanOrEqual(HOBBY_MIN_INTERVAL_MINUTES);
        expect(60 % step).toBe(0);
        perMonth += ((24 * 60) / step) * 31;
      } else {
        // 1 日 1 回（分・時が数値 1 つ）
        expect(min).toMatch(/^([0-9]|[1-5][0-9])$/);
        expect(hour).toMatch(/^([0-9]|1[0-9]|2[0-3])$/);
        perMonth += 31;
      }
      expect(s.jitter).toBeUndefined();
      expect(s.timezone).toBeUndefined();
    }
    // 31 日の月：1 日 96 回 × 31 日 + 1 日 1 回 × 31 日 = 3,007 回
    expect(perMonth).toBe(3_007);
    expect(perMonth).toBeLessThanOrEqual(HOBBY_RUNS_PER_MONTH);
  });

  it("保持期間の削除は、オーナー通知（毎時 0・15・30・45 分）と重ならない時刻・日本時間の深夜に実行する", () => {
    const [min, hour] = (vercelJson.schedules?.retention?.schedule ?? "").split(" ").map(Number);
    expect(min % 15).not.toBe(0);
    // Hobby は 15 分の幅で実行されるため、15 分ずらしても深夜（JST 2〜5 時）の範囲内
    const jst = (hour + 9) % 24;
    expect(jst).toBeGreaterThanOrEqual(2);
    expect(jst).toBeLessThan(5);
  });

  it("パスのターゲットは GET で、実在するルート。末尾スラッシュ・クエリ文字列を含まない（リダイレクトを追わない・秘密を URL に載せない）", () => {
    for (const s of Object.values(vercelJson.schedules ?? {})) {
      // 既定は POST のため、ルート（GET のみ公開）に合わせて GET を明示する。外すと 405 で毎回失敗する
      expect(s.requestMethod).toBe("GET");
      expect(s.function).toBeUndefined();
      expect(s.topic).toBeUndefined();
      expect(s.path).toMatch(/^\/api\/[a-z0-9/-]+[a-z0-9]$/);
      expect(s.path).not.toContain("?");
      expect(existsSync(join(ROOT, "src", "app", ...(s.path ?? "").split("/").filter(Boolean), "route.ts"))).toBe(true);
    }
  });

  it("スケジュール名は Vercel の命名規則に合う（変更すると履歴が別になるため固定）", () => {
    for (const name of Object.keys(vercelJson.schedules ?? {})) expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/);
  });

  it("秘密情報・環境変数・関数設定を含めない（CRON_SECRET は Vercel の環境変数にだけ置く）", () => {
    expect(vercelJson.env).toBeUndefined();
    expect(vercelJson.build).toBeUndefined();
    expect(vercelJson.functions).toBeUndefined();
    expect(vercelJsonText).not.toMatch(/secret|token|key|password|Bearer/i);
  });
});

describe("ルートの設定（Next.js 16・Cache Components）", () => {
  it("maxDuration は 60 秒（Vercel の既定 300 秒より短く、Hobby・Pro とも設定可能な範囲）", () => {
    expect(route.maxDuration).toBe(60);
    expect(route.maxDuration).toBeLessThanOrEqual(300);
    // 通常の処理（DB 数回・push 10 秒で打ち切り）より十分長い
    expect(route.maxDuration).toBeGreaterThanOrEqual(30);
  });

  it("GET だけを公開し、Cache Components で使えない dynamic・revalidate を書かない", () => {
    expect(typeof route.GET).toBe("function");
    expect(Object.keys(route).sort()).toEqual(["GET", "maxDuration"]);
  });
});

describe("環境変数による認証・無効化（GET /api/cron/owner-notify）", () => {
  it("CRON_SECRET が未設定なら、正しそうなヘッダーでも 503。DB にも LINE にも接続しない", async () => {
    Object.entries(SUPABASE).forEach(([k, v]) => vi.stubEnv(k, v));
    const res = await route.GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["空白だけ", "   "],
    ["短すぎる（31 文字）", "s".repeat(MIN_CRON_SECRET_LENGTH - 1)],
  ])("CRON_SECRET が%sなら 503（無効）", async (_l, secret) => {
    vi.stubEnv("CRON_SECRET", secret);
    const res = await route.GET(request(`Bearer ${secret}`));
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["ヘッダーなし", undefined],
    ["Bearer なし", SECRET],
    ["違う値", `Bearer ${"x".repeat(MIN_CRON_SECRET_LENGTH)}`],
    ["クエリ文字列での指定は受け付けない", ""],
  ])("認証に失敗（%s）したら 401。DB にも LINE にも接続しない", async (_l, auth) => {
    vi.stubEnv("CRON_SECRET", SECRET);
    Object.entries(SUPABASE).forEach(([k, v]) => vi.stubEnv(k, v));
    const res = await route.GET(
      auth === "" ? new Request(`https://example.invalid/api/cron/owner-notify?secret=${SECRET}`) : request(auth),
    );
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Supabase の接続情報がない（memory ストア）なら、認証後も何もせず 200（notification=disabled）", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await route.GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stalled: null, notification: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("LINE_REPLY_MODE が live でなければ通知は dry-run（LINE には接続しない）", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    Object.entries(SUPABASE).forEach(([k, v]) => vi.stubEnv(k, v));
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "dummy-token-not-real");
    const res = await route.GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect((await res.json()).notification).toBe("dry_run");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("api.line.me"))).toBe(false);
    // 停止イベントの検出（DB 関数）は呼ぶ。宛先は対象プロジェクトだけ
    expect(urls.every((u) => u.startsWith(`https://${SUPABASE_PROJECT_REF}.supabase.co/`))).toBe(true);
  });

  it("応答には件数と結果コードだけを含め、秘密・接続先を返さない", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    Object.entries(SUPABASE).forEach(([k, v]) => vi.stubEnv(k, v));
    const text = await (await route.GET(request(`Bearer ${SECRET}`))).text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(SUPABASE_PROJECT_REF);
    expect(text).not.toContain("sb_secret");
  });
});
