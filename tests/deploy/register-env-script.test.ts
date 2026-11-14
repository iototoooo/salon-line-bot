import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Vercel の環境変数の一括登録スクリプト（scripts/vercel/register-env.ps1）の安全条件を、ファイルの内容で確認する。
 * スクリプト自体は実行しない（Vercel・.env.local には触れない）。
 */
const raw = readFileSync(join(process.cwd(), "scripts", "vercel", "register-env.ps1"), "utf8");
// 説明のコメント（<# … #> と # で始まる行）を除いた、実行される部分
const code = raw
  .replace(/<#[\s\S]*?#>/, "")
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

const targetNames = [...code.matchAll(/@\{ Name = '([A-Z_]+)';\s+Type = '(secret|config)';\s+Source = '(local|fixed)'/g)].map((m) => ({
  name: m[1],
  type: m[2],
  source: m[3],
}));

describe("環境変数の一括登録スクリプト", () => {
  it("Windows PowerShell 5.1 で日本語を読めるよう BOM 付き", () => {
    expect(raw.charCodeAt(0)).toBe(0xfeff);
  });

  it("登録するのは初回デプロイ用の 9 項目だけ（docs/deployment.md 9.3 と同じ）。秘密の値は Secret", () => {
    expect(targetNames).toEqual([
      { name: "LINE_CHANNEL_SECRET", type: "secret", source: "local" },
      { name: "LINE_CHANNEL_ACCESS_TOKEN", type: "secret", source: "local" },
      { name: "LINE_REPLY_MODE", type: "config", source: "fixed" },
      { name: "LINE_RESPONDER", type: "config", source: "fixed" },
      { name: "NEXT_PUBLIC_SUPABASE_URL", type: "config", source: "fixed" },
      { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", type: "config", source: "local" },
      { name: "SUPABASE_URL", type: "config", source: "fixed" },
      { name: "SUPABASE_SERVICE_ROLE_KEY", type: "secret", source: "local" },
      { name: "WEBHOOK_EVENT_STORE", type: "config", source: "fixed" },
    ]);
  });

  it("安全に関わる値は固定値（返信は dry-run・AI 応答・Supabase の重複判定・対象プロジェクトの URL）", () => {
    expect(code).toMatch(/Name = 'LINE_REPLY_MODE';[^\n]*Value = 'dry-run'/);
    expect(code).toMatch(/Name = 'LINE_RESPONDER';[^\n]*Value = 'ai'/);
    expect(code).toMatch(/Name = 'WEBHOOK_EVENT_STORE';[^\n]*Value = 'supabase'/);
    expect(code).toContain("$SupabaseUrl = 'https://dnortggovlwgcdeoadbf.supabase.co'");
  });

  it.each(["CRON_SECRET", "ANTHROPIC_API_KEY", "ADMIN_WRITE_MODE", "LINE_BROADCAST_MODE", "ADMIN_ANSWER_TEST_MODE"])(
    "%s は登録の対象にしない（登録しないものの一覧に入れる）",
    (name) => {
      expect(targetNames.map((t) => t.name)).not.toContain(name);
      expect(code).toMatch(new RegExp(`\\$Forbidden = @\\([^)]*'${name}'`));
    },
  );

  it("登録先は Production だけ。既定は dry-run で、-Apply のときだけ登録する", () => {
    expect(code).toContain("$Environment = 'production'");
    expect(code).toMatch(/'env', 'add', \$t\.Name, '--environment', \$Environment, '--type', \$t\.Type\) \$values\[\$t\.Name\]/);
    expect(code).toMatch(/if \(-not \$Apply\) \{[\s\S]*?exit 0/);
  });

  it("値を引数に含めない・上書きしない・確認を飛ばさない・env pull をしない", () => {
    for (const bad of ["--value", "--force", "--yes", "env pull", "'pull'", "Set-Content", "Out-File", "Add-Content"]) {
      expect(code).not.toContain(bad);
    }
    // .env.local は読み取りだけ
    expect(code).toMatch(/ReadAllLines\(\$envFile\)/);
    expect(code).not.toMatch(/Write\w*\(\$envFile/);
  });

  it("標準入力に BOM が付かないようにし、ダミーの値で受け渡しを確かめてから登録する", () => {
    expect(code).toContain("[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)");
    expect(code.indexOf("Test-StdinPassthrough)")).toBeGreaterThan(-1);
    expect(code.indexOf("if (-not (Test-StdinPassthrough))")).toBeLessThan(code.indexOf("'env', 'add'"));
  });

  it("登録前にプロジェクト名・プロジェクト ID・チーム ID を照合し、値に問題があれば何も登録せずに止まる", () => {
    expect(code).toContain("$pj.id -ne $link.projectId");
    expect(code).toContain("$_.id -eq $link.orgId");
    const stopOnProblems = code.indexOf("Fail '値に問題があるため、何も登録せずに停止しました'");
    expect(stopOnProblems).toBeGreaterThan(-1);
    expect(stopOnProblems).toBeLessThan(code.indexOf("'env', 'add'"));
  });
});
