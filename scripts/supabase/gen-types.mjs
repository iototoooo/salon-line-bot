// 対象プロジェクト（salon-line-bot / dnortggovlwgcdeoadbf）の DB から TypeScript の型を生成する。
// 読み取りのみ（DB・設定は変更しない）。npm run gen:types で実行する。
//
// - 接続先の Ref は固定（別プロジェクトの型を取り込まない）
// - 生成に失敗した、または出力が想定外のときは既存ファイルを上書きしない
// - 認証は Supabase CLI に保存済みのトークン（または SUPABASE_ACCESS_TOKEN）を使う。値は扱わない
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_REF = "dnortggovlwgcdeoadbf";
const CLI = "supabase@3.1.0";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outFile = join(root, "src", "types", "database.generated.ts");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (pkg.name !== "salon-line-bot") {
  console.error("salon-line-bot リポジトリではないため中止します");
  process.exit(1);
}

let output;
try {
  // 引数はすべて固定値（外部入力を含まない）。Windows の npx.cmd を呼ぶためシェル経由で実行する
  const command = `npx --yes ${CLI} --workdir "${root}" gen types --remote=${PROJECT_REF} --lang typescript --schema public`;
  output = execSync(command, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 10 * 1024 * 1024 });
} catch {
  console.error("型の生成に失敗しました。既存のファイルは変更していません");
  process.exit(1);
}

if (!output.includes("export type Database =") || !output.includes("line_webhook_events")) {
  console.error("生成結果が想定と異なるため中止します。既存のファイルは変更していません");
  process.exit(1);
}

const header = `// このファイルは自動生成です。手で編集しないこと。
// 生成: npm run gen:types（Supabase CLI ${CLI} / Project Ref ${PROJECT_REF} / schema public）
// 独自の型（CHECK 制約に対応する値の限定など）は src/types/database.ts に書く。

`;
writeFileSync(outFile, header + output.replace(/\r\n/g, "\n"), "utf8");
console.log(`生成しました: ${outFile}`);
