import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN, card, dbQuery, expect, login, test } from "./fixtures";

/**
 * README・ポートフォリオ用の画面キャプチャを docs/images/ に保存する（通常のブラウザ自動テストには含めない）。
 *
 *   $env:CAPTURE_SCREENSHOTS = '1'; npx playwright test e2e/screenshots.spec.ts; Remove-Item env:CAPTURE_SCREENSHOTS
 *
 * - 接続先はローカルの偽の Supabase だけ（本番の DB・LINE・Claude には接続しない。playwright.config.ts 参照）
 * - データは学習用の架空店舗（scripts/supabase/sample-data/sample-salon.sql）と、偽の DB の初期データ（ダミーの会話）だけ
 * - 画面に LINE ユーザー ID は表示されない（管理画面の仕様）。ログインの画面のメールアドレス欄は空のまま撮る
 */
const OUT = join(process.cwd(), "docs", "images");
const SAMPLE = readFileSync(join(process.cwd(), "scripts", "supabase", "sample-data", "sample-salon.sql"), "utf8");

/** サンプルの SQL から、店舗情報の更新・メニュー・FAQ の 3 文だけを取り出す（偽の DB は 1 回に 1 文だけ実行できるため） */
function sampleStatements(): string[] {
  const pick = (re: RegExp) => {
    const m = re.exec(SAMPLE);
    if (!m) throw new Error(`sample statement not found: ${re}`);
    return m[0];
  };
  return [
    pick(/update public\.shop_settings set[\s\S]*?where id = 1;/),
    pick(/insert into public\.menus[\s\S]*?\);\n/),
    pick(/insert into public\.faqs[\s\S]*?\);\n/),
  ];
}

const shot = async (page: import("@playwright/test").Page, name: string) => {
  await page.waitForLoadState("networkidle");
  // 開発サーバーの表示（Next.js の開発用インジケーター）を隠す
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
};

/** 見出しが画面の上端の近くに来るようにスクロールする */
const toListHeading = async (page: import("@playwright/test").Page, name: string) => {
  const h = page.getByRole("heading", { name, exact: true });
  await expect(h).toBeVisible();
  await h.evaluate((el) => {
    el.scrollIntoView({ block: "start" });
    window.scrollBy(0, -100);
  });
};

test.describe("README 用の画面キャプチャ", () => {
  test.skip(process.env.CAPTURE_SCREENSHOTS !== "1", "CAPTURE_SCREENSHOTS=1 のときだけ撮影する");
  test.use({ viewport: { width: 1280, height: 800 } });

  test("管理画面の主要な画面を撮影する", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    for (const sql of sampleStatements()) await dbQuery(sql);
    // 偽の DB の初期データの会話を、架空の問い合わせの文面にそろえる（偽の DB の中だけの変更）
    await dbQuery(`update public.conversations set user_message = 'シャンプーは店頭で購入できますか？' where line_event_id = 'e2e-ev-1'`);
    await dbQuery(`update public.conversations set user_message = '日曜日の午後に予約したいです' where line_event_id = 'e2e-ev-2'`);
    await dbQuery(`update public.conversations set user_message = '営業時間を教えてください', bot_reply = '平日は 10:00〜19:00、土日祝は 9:00〜18:00 です。' where line_event_id = 'e2e-ev-3'`);

    await page.goto("/login");
    await expect(page.getByRole("button", { name: "ログイン" })).toBeVisible();
    await shot(page, "01-login");

    await login(page, ADMIN);
    await expect(page.getByRole("heading", { name: "ホーム" })).toBeVisible();
    await shot(page, "02-home");

    await page.goto("/admin/faqs");
    await expect(page.getByText("営業時間を教えてください").first()).toBeVisible();
    // 追加のフォームではなく、登録済みの一覧が見える位置にする
    await toListHeading(page, "登録済み（12 件）");
    await shot(page, "03-faqs");

    await page.goto("/admin/menus");
    await expect(page.getByText("カット＋カラー").first()).toBeVisible();
    await toListHeading(page, "登録済み（10 件）");
    await shot(page, "04-menus");

    await page.goto("/admin/settings");
    await expect(page.getByText("自動応答").first()).toBeVisible();
    await shot(page, "05-settings");

    await page.goto("/admin/inbox");
    await expect(page.getByText("日曜日の午後に予約したいです").first()).toBeVisible();
    await shot(page, "06-inbox");

    await page.goto("/admin/answer-test");
    await page.getByLabel("お客様の質問（LINE には送信されません）").fill("カットはいくらですか？");
    await page.getByRole("button", { name: "回答を確認する" }).click();
    await expect(page.getByText("（AI は呼び出していません）")).toBeVisible();
    await shot(page, "07-answer-test");

    await page.goto("/admin/broadcasts");
    await card(page, "新しいお知らせ（下書き）").getByLabel("本文").fill("【お知らせ】年末年始は 12/30〜1/3 までお休みをいただきます。");
    await page.getByRole("button", { name: "下書きを保存" }).click();
    await expect(page).toHaveURL(/\/admin\/broadcasts\/[0-9a-f-]{36}$/);
    await shot(page, "08-broadcast");
  });
});
