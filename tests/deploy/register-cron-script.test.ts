import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 定期実行を有効にするスクリプト（scripts/vercel/register-cron.ps1）の安全条件を、ファイルの内容で確認する。
 * スクリプト自体は実行しない（Vercel には触れない）。
 */
const raw = readFileSync(join(process.cwd(), "scripts", "vercel", "register-cron.ps1"), "utf8");
// 説明のコメント（<# … #> と # で始まる行）を除いた、実行される部分
const code = raw
  .replace(/<#[\s\S]*?#>/, "")
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");
const addCalls = [...code.matchAll(/@\('env', 'add', '([A-Z_]+)', '--environment', \$Environment, '--type', '(secret|config)'\)/g)].map(
  (m) => `${m[1]}:${m[2]}`,
);

describe("定期実行を有効にするスクリプト", () => {
  it("Windows PowerShell 5.1 で日本語を読めるよう BOM 付き", () => {
    expect(raw.charCodeAt(0)).toBe(0xfeff);
  });

  it("登録するのは CRON_SECRET（Secret）と APP_BASE_URL（Config）の 2 つだけ。登録先は Production", () => {
    expect(addCalls).toEqual(["CRON_SECRET:secret", "APP_BASE_URL:config"]);
    expect(code).toContain("$Environment = 'production'");
    expect(code).toContain("$AppBaseUrl = 'https://salon-line-bot-nine.vercel.app'");
  });

  it("CRON_SECRET は暗号用の乱数で 64 文字の英数字（Vercel が受け付ける文字だけ）。画面・ファイル・クリップボードに出さない", () => {
    expect(code).toContain("[System.Security.Cryptography.RandomNumberGenerator]::Create()");
    expect(code).toContain("New-Object byte[] 32");
    expect(code).toContain("'^[0-9a-f]{64}$'");
    for (const bad of ["Set-Clipboard", "Write-Host $secret", "Write-Output $secret", "Out-File", "Set-Content", "Add-Content"]) {
      expect(code).not.toContain(bad);
    }
    // 値は標準入力で渡し、使ったらすぐに消す
    expect(code).toMatch(/'--type', 'secret'\) \$secret\n\$secret = \$null/);
  });

  it("値を引数に含めない・上書きしない・確認を飛ばさない・env pull・デプロイをしない", () => {
    for (const bad of ["--value", "--force", "--yes", "env pull", "'pull'", "'deploy'", "--prod"]) {
      expect(code).not.toContain(bad);
    }
  });

  it("dry-run が既定で、-Apply のときだけ登録する。登録の前に止まる条件をすべて確認する", () => {
    const firstAdd = code.indexOf("'env', 'add'");
    expect(code.indexOf("if (-not $Apply) {")).toBeLessThan(firstAdd);
    for (const guard of [
      "if (-not (Test-StdinPassthrough))",
      "$pj.id -ne $link.projectId",
      "$_.id -eq $link.orgId",
      "初回デプロイの変数がそろっていません",
      "今回は登録されていないはずの変数があります",
      "すでに登録されています（上書きしないため停止）",
      "Production 以外の環境に登録されている変数があります",
    ]) {
      const at = code.indexOf(guard);
      expect(at, guard).toBeGreaterThan(-1);
      expect(at, guard).toBeLessThan(firstAdd);
    }
  });

  it("AI・安全スイッチが登録されていれば停止する（返信は dry-run・AI なしのまま定期実行だけを有効にする）", () => {
    for (const name of ["ANTHROPIC_API_KEY", "ADMIN_WRITE_MODE", "LINE_BROADCAST_MODE", "ADMIN_ANSWER_TEST_MODE"]) {
      expect(code).toMatch(new RegExp(`\\$Forbidden = @\\([^)]*'${name}'`));
    }
    expect(code).toMatch(/\$Required = @\([^)]*'LINE_REPLY_MODE'/);
  });

  it("標準入力に BOM が付かないようにしている", () => {
    expect(code).toContain("[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)");
  });
});
