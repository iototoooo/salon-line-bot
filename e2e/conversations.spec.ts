import { ADMIN, CONV, dbQuery, expect, login, test } from "./fixtures";

/** 会話管理（バッチ 3）：未対応一覧・対応済み・会話ログの絞り込み・回答テスト */

test.describe("未対応一覧", () => {
  test("対応済みにすると一覧から消え、ほかの会話は残る。対応者はログイン中の管理者", async ({ page }) => {
    await login(page, ADMIN, "/admin/inbox");
    await expect(page.getByText(/未対応：\s*2 件/)).toBeVisible();
    const target = page.locator("section").filter({ hasText: "E2E：駐車場はありますか" });
    const other = page.locator("section").filter({ hasText: "E2E：シャンプーは売っていますか" });
    await expect(other.getByText("LINE 通知済み")).toBeVisible();

    await target.getByRole("button", { name: "対応済みにする" }).click();
    await expect(page.getByText(/未対応：\s*1 件/)).toBeVisible();
    await expect(page.locator("section").filter({ hasText: "E2E：駐車場はありますか" })).toHaveCount(0);
    await expect(other).toBeVisible();

    const rows = await dbQuery<{ id: string; resolved: boolean; resolved_by: string | null }>(
      "select id, resolved_at is not null as resolved, resolved_by::text as resolved_by from public.conversations order by id",
    );
    expect(rows).toEqual([
      { id: CONV.notifiedUnresolved, resolved: false, resolved_by: null },
      { id: CONV.unresolved, resolved: true, resolved_by: ADMIN.id },
      { id: CONV.answered, resolved: false, resolved_by: null },
    ]);
  });

  test("お客様の LINE ユーザー ID は画面に表示しない", async ({ page }) => {
    await login(page, ADMIN, "/admin/inbox");
    await expect(page.getByText(/未対応：\s*2 件/)).toBeVisible();
    const html = await page.content();
    for (const d of ["1", "2", "3"]) expect(html).not.toContain(`U${d.repeat(32)}`);
    await expect(page.getByText(/お客様 #[0-9a-f]{6}/).first()).toBeVisible();
  });
});

test.describe("会話ログ", () => {
  test("未対応のみ・日付で絞り込める（データは変更しない）", async ({ page }) => {
    await login(page, ADMIN, "/admin/conversations");
    await expect(page.getByText(/^3 件$/)).toBeVisible();

    await page.getByLabel("未対応のみ").check();
    await page.getByRole("button", { name: "絞り込む" }).click();
    await expect(page).toHaveURL(/status=unresolved/);
    await expect(page.getByText(/^2 件$/)).toBeVisible();

    // 3 日前（日本時間）の日付だけ
    const d = new Date(Date.now() + 9 * 3_600_000 - 3 * 86_400_000).toISOString().slice(0, 10);
    await page.goto(`/admin/conversations?date=${d}`);
    await expect(page.getByText(/^1 件$/)).toBeVisible();
    await expect(page.getByText("E2E：営業時間は？")).toBeVisible();

    // 不正な日付は無視してすべて表示
    await page.goto("/admin/conversations?date=2026-13-99");
    await expect(page.getByText("日付の形式が正しくないため、すべての日付を表示しています。")).toBeVisible();
    expect(await dbQuery("select count(*)::int as n from public.conversations where resolved_at is not null")).toEqual([{ n: 0 }]);
  });
});

test.describe("回答テスト", () => {
  test("AI を呼ばない設定では、事前判定の結果だけを表示し、会話ログに保存しない", async ({ page }) => {
    await login(page, ADMIN, "/admin/answer-test");
    await expect(page.getByText(/現在は AI を呼び出しません/)).toBeVisible();
    await page.getByLabel("お客様の質問（LINE には送信されません）").fill("カットはいくらですか？");
    await page.getByRole("button", { name: "回答を確認する" }).click();
    await expect(page.getByText("（AI は呼び出していません）")).toBeVisible();
    await expect(page.getByText(/AI は呼び出していません（安全のための初期設定/)).toBeVisible();
    expect(await dbQuery("select count(*)::int as n from public.conversations")).toEqual([{ n: 3 }]);
    expect(await dbQuery("select count(*)::int as n from public.ai_usage_reservations")).toEqual([{ n: 0 }]);
  });
});
