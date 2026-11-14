import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as notifyRoute from "@/app/api/cron/owner-notify/route";
import * as retentionRoute from "@/app/api/cron/retention/route";
import { readAdminModes } from "@/lib/admin/mode";
import { createResponderFromEnv, resolveResponderKind } from "@/lib/bot/config";
import { createWebhookEventStore, getReplyMode } from "@/lib/line/config";
import { SUPABASE_PROJECT_REF } from "@/lib/supabase/server";

/**
 * Vercel（Hobby）に初めてデプロイしたとき、環境変数の設定漏れ・既定値のままでも
 * 「お客様への返信・一斉配信・AI の呼び出し・定期削除」が勝手に始まらないことを確認する（docs/deployment.md 8.1）。
 * 実際の Supabase・LINE・Claude API には接続しない（fetch はスタブして、呼ばれないことを確認する）。
 */
const PROD = { VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv;
const SUPABASE = {
  SUPABASE_URL: `https://${SUPABASE_PROJECT_REF}.supabase.co`,
  // テスト専用のダミー値（実在しない）
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_DUMMYdummyDUMMYdummy0123",
};

describe("本番（VERCEL_ENV=production）の既定値", () => {
  it("LINE_REPLY_MODE を設定しなければ dry-run（お客様へ送信しない）。live 以外の値も dry-run", () => {
    expect(getReplyMode(PROD)).toBe("dry-run");
    expect(getReplyMode({ ...PROD, LINE_REPLY_MODE: "LIVE " })).not.toBe("live");
  });

  it("管理画面の安全スイッチ（保存・LINE 送信・AI の回答テスト）は、設定しなければすべて OFF", () => {
    expect(readAdminModes({ ...PROD, LINE_CHANNEL_ACCESS_TOKEN: "dummy", ANTHROPIC_API_KEY: "dummy" })).toEqual({
      writeEnabled: false,
      lineSendEnabled: false,
      answerTestAiEnabled: false,
    });
  });

  it("返信内容の設定（LINE_RESPONDER）が未設定なら、Echo で動かずエラーで止まる（ai の指定が必須）", () => {
    expect(() => resolveResponderKind(PROD)).toThrow(/not allowed in production/);
    expect(() => createResponderFromEnv({ ...PROD, LINE_RESPONDER: "ai" })).toThrow(/requires SUPABASE_URL/);
    expect(resolveResponderKind({ ...PROD, LINE_RESPONDER: "ai" })).toBe("ai");
  });

  it("Supabase の接続情報がなければ、重複判定をメモリで代用せずエラーで止まる", () => {
    expect(() => createWebhookEventStore(PROD)).toThrow(/not allowed in production/);
    expect(() => createWebhookEventStore({ ...PROD, ...SUPABASE })).not.toThrow();
  });
});

describe("初回デプロイ（CRON_SECRET 未設定）の定期実行", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    for (const k of ["CRON_SECRET", "LINE_REPLY_MODE", "LINE_CHANNEL_ACCESS_TOKEN"]) vi.stubEnv(k, "");
    vi.stubEnv("VERCEL_ENV", "production");
    Object.entries(SUPABASE).forEach(([k, v]) => vi.stubEnv(k, v));
    fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    ["保持期間の削除（/api/cron/retention）", retentionRoute.GET],
    ["オーナー通知（/api/cron/owner-notify）", notifyRoute.GET],
  ])("%s は 503 で、DB にも LINE にも接続しない（Vercel が Bearer を付けて呼んでも何もしない）", async (_l, GET) => {
    const res = await GET(new Request("https://example.invalid/api/cron/x", { headers: { authorization: "Bearer " } }));
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Vercel CLI でのデプロイの設定（docs/deployment.md 9 章）", () => {
  const ROOT = process.cwd();
  const vercelJson = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as { regions?: string[] };
  const ignore = readFileSync(join(ROOT, ".vercelignore"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  it("フレームワークは Next.js を明示する（未指定だと Vercel が静的サイトとして扱い、public がないとデプロイが失敗する。2026-11-13 の初回デプロイで発生）", () => {
    expect((vercelJson as { framework?: string }).framework).toBe("nextjs");
  });

  it("Node.js の版はローカルの検証と同じ 24 系に固定する（Vercel の新規プロジェクトの既定は 26.x だった）", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBe("24.x");
    expect(process.versions.node.split(".")[0]).toBe("24");
  });

  it("関数は東京（hnd1）の 1 リージョンだけで動かす（Supabase と同じ ap-northeast-1。Hobby は 1 リージョンまで）", () => {
    expect(vercelJson.regions).toEqual(["hnd1"]);
  });

  it.each([".env*", ".claude/", "supabase/.temp/", "supabase/.branches/", "test-results/", "*.tsbuildinfo"])(
    ".vercelignore で %s をアップロードしない",
    (entry) => {
      expect(ignore).toContain(entry);
    },
  );

  it(".vercelignore はビルドに必要なファイルを除外しない（全除外・src・設定ファイルの除外がない）", () => {
    for (const bad of ["/*", "*", "src", "src/", "package.json", "package-lock.json", "next.config.ts", "vercel.json", "tsconfig.json", "supabase/"]) {
      expect(ignore).not.toContain(bad);
    }
    expect(ignore.some((l) => l.startsWith("!"))).toBe(false);
  });
});
