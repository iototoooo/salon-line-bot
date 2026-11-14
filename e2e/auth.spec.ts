import { ADMIN, expect, formError, login, NON_ADMIN, test } from "./fixtures";

/** ログイン・ログアウト・未ログイン時の保護（AC-21） */
test.describe("ログイン", () => {
  test("未ログインで管理画面を開くとログイン画面へ。ログイン後は元のページに戻る", async ({ page }) => {
    await page.goto("/admin/faqs");
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Ffaqs$/);
    await expect(page.getByRole("heading", { name: "管理画面にログイン" })).toBeVisible();
    // ログイン前はデータが表示されない
    await expect(page.getByText("FAQ（よくある質問）")).toHaveCount(0);

    await page.getByLabel("メールアドレス").fill(ADMIN.email);
    await page.getByLabel("パスワード").fill(ADMIN.password);
    await page.getByRole("button", { name: "ログイン" }).click();
    await expect(page).toHaveURL(/\/admin\/faqs$/);
    await expect(page.getByRole("heading", { name: "FAQ（よくある質問）" })).toBeVisible();
    await expect(page.getByText(ADMIN.email)).toBeVisible();
  });

  test("パスワード違いはエラーを表示し、ログインしない", async ({ page }) => {
    await login(page, { ...ADMIN, password: "wrong-password" });
    await expect(formError(page)).toHaveText("メールアドレスまたはパスワードが正しくありません。");
    await expect(page).toHaveURL(/\/login/);
  });

  test("管理者でないアカウントは、パスワード違いと同じメッセージでログインできない", async ({ page }) => {
    await login(page, { ...NON_ADMIN, id: "" });
    await expect(formError(page)).toHaveText("メールアドレスまたはパスワードが正しくありません。");
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login/);
  });

  test("ログイン Cookie は JavaScript から読めず（HttpOnly）、画面は iframe に埋め込めない", async ({ page, context }) => {
    await login(page);
    await expect(page.getByRole("heading", { name: "ホーム" })).toBeVisible();
    const authCookies = (await context.cookies()).filter((c) => c.name.startsWith("sb-"));
    expect(authCookies.length).toBeGreaterThan(0);
    for (const c of authCookies) {
      expect(c.httpOnly).toBe(true);
      expect(c.sameSite).toBe("Lax");
    }
    // ブラウザの JavaScript からはセッションの Cookie が見えない
    expect(await page.evaluate(() => document.cookie)).not.toMatch(/sb-/);
    const res = await page.request.get("/admin");
    expect(res.headers()["x-frame-options"]).toBe("DENY");
    expect(res.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  test("ログアウトするとログイン画面に戻り、管理画面を開けなくなる", async ({ page }) => {
    await login(page);
    await expect(page.getByRole("heading", { name: "ホーム" })).toBeVisible();
    await page.getByRole("button", { name: "ログアウト" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/admin/inbox");
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Finbox$/);
  });
});
