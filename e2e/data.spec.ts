import { ADMIN, card, dbQuery, expect, formError, formSuccess, login, test } from "./fixtures";

/**
 * データ管理（バッチ 2）：FAQ・メニュー・店舗情報・自動応答 ON/OFF・通知先。
 * 偽の DB（PGlite）に対して、画面の操作 → 保存 → 表示 → DB の内容を確認する。
 */

test.describe("FAQ", () => {
  test("追加（非公開）→ 入力エラー → 編集 → 公開切り替え → 削除", async ({ page }) => {
    await login(page, ADMIN, "/admin/faqs");
    const add = card(page, "FAQ を追加");

    // 追加（非公開）
    await add.locator('[name="question"]').fill("【E2E】駐車場はありますか？");
    await add.locator('[name="answer"]').fill("テスト用の回答です。");
    await add.getByLabel("分類").selectOption("access");
    await add.getByLabel("公開する（AI の回答に使う）").uncheck();
    await add.getByRole("button", { name: "追加する" }).click();
    await expect(formSuccess(page)).toHaveText("FAQ を追加しました。");
    const item = page.locator("section").filter({ hasText: "Q. 【E2E】駐車場はありますか？" });
    await expect(item).toBeVisible();
    await expect(item.getByText("非公開", { exact: true })).toBeVisible();
    expect(await dbQuery("select question, answer, category, is_published from public.faqs")).toEqual([
      { question: "【E2E】駐車場はありますか？", answer: "テスト用の回答です。", category: "access", is_published: false },
    ]);

    // 入力エラー（ブラウザの必須チェックを外し、サーバー側の検証を確認する）
    await add.locator('[name="question"]').evaluate((el) => el.removeAttribute("required"));
    await add.locator('[name="answer"]').fill("質問なし");
    await add.getByRole("button", { name: "追加する" }).click();
    await expect(add.locator('p[role="alert"]')).toContainText("入力内容に誤りがあります");
    await expect(add.getByText("入力してください。")).toBeVisible();
    expect(await dbQuery("select count(*)::int as n from public.faqs")).toEqual([{ n: 1 }]);

    // 編集
    await item.getByText("編集・公開切り替え・削除").click();
    const forms = item.locator("form");
    await forms.nth(0).locator('[name="answer"]').fill("テスト用の回答（編集後）です。");
    await forms.nth(0).getByRole("button", { name: "保存する" }).click();
    await expect(page.getByText("A. テスト用の回答（編集後）です。")).toBeVisible();

    // 公開 → 非公開
    const reopen = async () => {
      const it = page.locator("section").filter({ hasText: "Q. 【E2E】駐車場はありますか？" });
      if (!(await it.locator("details").evaluate((d) => (d as HTMLDetailsElement).open))) await it.getByText("編集・公開切り替え・削除").click();
      return it;
    };
    await (await reopen()).getByRole("button", { name: "公開する" }).click();
    await expect(page.locator("section").filter({ hasText: "Q. 【E2E】" }).getByText("公開中", { exact: true })).toBeVisible();
    expect(await dbQuery("select is_published from public.faqs")).toEqual([{ is_published: true }]);
    await (await reopen()).getByRole("button", { name: "非公開にする" }).click();
    await expect(page.locator("section").filter({ hasText: "Q. 【E2E】" }).getByText("非公開", { exact: true })).toBeVisible();
    expect(await dbQuery("select is_published, answer from public.faqs")).toEqual([
      { is_published: false, answer: "テスト用の回答（編集後）です。" },
    ]);

    // 削除：チェックなしは拒否、チェックありで削除
    const del = (await reopen()).locator("form").filter({ has: page.getByRole("button", { name: "削除" }) });
    await del.getByRole("button", { name: "削除" }).click();
    await expect(del.locator('p[role="alert"]')).toContainText("「削除する」にチェック");
    expect(await dbQuery("select count(*)::int as n from public.faqs")).toEqual([{ n: 1 }]);
    await del.getByLabel("削除する（元に戻せません）").check();
    await del.getByRole("button", { name: "削除" }).click();
    await expect(page.getByText("まだ FAQ が登録されていません。")).toBeVisible();
    expect(await dbQuery("select count(*)::int as n from public.faqs")).toEqual([{ n: 0 }]);
  });
});

test.describe("メニュー・料金", () => {
  test("全角・カンマ付きの料金で追加 → 不正な料金はエラー → 編集 → 削除", async ({ page }) => {
    await login(page, ADMIN, "/admin/menus");
    const add = card(page, "メニューを追加");

    await add.getByLabel("メニュー名").fill("【E2E】カット");
    await add.getByLabel("料金（税込・円）").fill("４，４００");
    await add.getByLabel("公開する（AI の回答に使う）").uncheck();
    await add.getByRole("button", { name: "追加する" }).click();
    await expect(formSuccess(page)).toHaveText("メニューを追加しました。");
    const item = page.locator("section").filter({ hasText: "【E2E】カット" }).filter({ hasText: "円" });
    await expect(item.getByText("4,400円")).toBeVisible();
    expect(await dbQuery("select name, price, is_published from public.menus")).toEqual([
      { name: "【E2E】カット", price: 4400, is_published: false },
    ]);

    // 不正な料金（小数）
    await add.getByLabel("メニュー名").fill("【E2E】不正");
    await add.getByLabel("料金（税込・円）").fill("4400.5");
    await add.getByRole("button", { name: "追加する" }).click();
    await expect(add.getByText("半角の整数で入力してください。")).toBeVisible();
    expect(await dbQuery("select count(*)::int as n from public.menus")).toEqual([{ n: 1 }]);

    // 編集
    await item.getByText("編集・公開切り替え・削除").click();
    const edit = item.locator("form").first();
    await edit.getByLabel("料金（税込・円）").fill("4950");
    await edit.getByRole("button", { name: "保存する" }).click();
    await expect(page.getByText("4,950円")).toBeVisible();
    expect(await dbQuery("select price from public.menus")).toEqual([{ price: 4950 }]);

    // 削除
    const it2 = page.locator("section").filter({ hasText: "【E2E】カット" }).filter({ hasText: "円" });
    if (!(await it2.locator("details").evaluate((d) => (d as HTMLDetailsElement).open))) await it2.getByText("編集・公開切り替え・削除").click();
    const del = it2.locator("form").filter({ has: page.getByRole("button", { name: "削除" }) });
    await del.getByLabel("削除する（元に戻せません）").check();
    await del.getByRole("button", { name: "削除" }).click();
    await expect(page.getByText("まだメニューが登録されていません。")).toBeVisible();
    expect(await dbQuery("select count(*)::int as n from public.menus")).toEqual([{ n: 0 }]);
  });
});

test.describe("店舗情報・設定", () => {
  test("店舗情報を保存し、元に戻せる", async ({ page }) => {
    await login(page, ADMIN, "/admin/settings");
    const shop = card(page, "店舗情報");
    await expect(shop.getByLabel("店名")).toHaveValue("E2E テスト店");
    const notice = () => dbQuery("select temporary_notice, shop_name from public.shop_settings");
    await shop.getByLabel("臨時のお知らせ").fill("【E2E】臨時のお知らせ");
    await shop.getByRole("button", { name: "保存する" }).click();
    await expect(shop.locator('p[role="status"]')).toContainText("店舗情報を保存しました");
    await expect.poll(notice).toEqual([{ temporary_notice: "【E2E】臨時のお知らせ", shop_name: "E2E テスト店" }]);

    // 2 回目も同じメッセージが出るため、DB の内容が変わるまで待つ
    await shop.getByLabel("臨時のお知らせ").fill("");
    await shop.getByRole("button", { name: "保存する" }).click();
    await expect.poll(notice).toEqual([{ temporary_notice: "", shop_name: "E2E テスト店" }]);
  });

  test("自動応答 ON/OFF は確認の文言が違えば変更されない（OFF のまま）", async ({ page }) => {
    await login(page, ADMIN, "/admin/settings");
    const bot = card(page, "自動応答（緊急停止スイッチ）");
    await expect(bot.getByText("OFF（定型文のみ）")).toBeVisible();
    await bot.getByLabel("確認のため「変更する」と入力").fill("はい");
    await bot.getByRole("button", { name: "自動応答を ON にする" }).click();
    await expect(bot.getByText("確認のため「変更する」と入力してください。").last()).toBeVisible();
    expect(await dbQuery("select bot_enabled from public.shop_settings")).toEqual([{ bot_enabled: false }]);
  });

  test("通知先：形式違いは保存しない。保存した ID は画面に表示しない", async ({ page }) => {
    await login(page, ADMIN, "/admin/settings");
    const owner = card(page, "オーナー通知の送り先（LINE）");
    await expect(owner.getByText("未設定（通知は送られません）")).toBeVisible();

    await owner.getByLabel("LINE ユーザー ID").fill("U123");
    await owner.getByRole("button", { name: "保存する" }).click();
    await expect(owner.getByText(/形式が正しくありません/)).toBeVisible();
    expect(await dbQuery("select owner_line_user_id from public.shop_settings")).toEqual([{ owner_line_user_id: null }]);

    // 偽の DB だけで確認する（テスト用のダミー ID）
    const dummy = `U${"9".repeat(32)}`;
    await owner.getByLabel("LINE ユーザー ID").fill(dummy);
    await owner.getByRole("button", { name: "保存する" }).click();
    await expect(owner.getByText("設定済み", { exact: true })).toBeVisible();
    expect(await dbQuery("select owner_line_user_id from public.shop_settings")).toEqual([{ owner_line_user_id: dummy }]);
    await page.reload();
    await expect(card(page, "オーナー通知の送り先（LINE）").getByText("設定済み", { exact: true })).toBeVisible();
    expect(await page.content()).not.toContain(dummy);
    await expect(card(page, "オーナー通知の送り先（LINE）").getByLabel("LINE ユーザー ID")).toHaveValue("");
  });
});

test.describe("ホーム", () => {
  test("未対応の件数・自動応答・通知先・登録件数を表示する", async ({ page }) => {
    await login(page);
    await expect(card(page, "未対応のお問い合わせ").getByText("2 件")).toBeVisible();
    await expect(card(page, "自動応答").getByText("OFF（定型文のみ）")).toBeVisible();
    await expect(page.getByText("FAQ またはメニューが未登録です。")).toBeVisible();
    // 安全スイッチ：保存は有効、LINE 送信と AI 呼び出しは無効
    await expect(page.getByText(/次の操作は無効になっています：LINE への送信・回答テストでの AI 呼び出し/)).toBeVisible();
    await expect(formError(page)).toHaveCount(0);
  });
});
