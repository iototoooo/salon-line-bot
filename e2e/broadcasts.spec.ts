import { ADMIN, card, dbQuery, expect, login, test } from "./fixtures";

/**
 * 一斉配信（バッチ 4）：下書き・プレビュー・編集・削除と、送信が無効のときの安全確認。
 * LINE への送信は安全スイッチで無効（テスト用サーバーは LINE のトークンも持たない）。
 */

test.describe("お知らせ配信", () => {
  test("下書き → プレビュー → 編集 → 削除。送信のボタンは押せない", async ({ page }) => {
    await login(page, ADMIN, "/admin/broadcasts");
    await expect(page.getByText("まだ配信はありません。")).toBeVisible();

    await card(page, "新しいお知らせ（下書き）").getByLabel("本文").fill("【E2E】臨時休業のお知らせです。");
    await page.getByRole("button", { name: "下書きを保存" }).click();
    await expect(page).toHaveURL(/\/admin\/broadcasts\/[0-9a-f-]{36}$/);
    await expect(page.getByText("下書き", { exact: true })).toBeVisible();
    await expect(card(page, "プレビュー（LINE での見え方の目安）").getByText("【E2E】臨時休業のお知らせです。")).toBeVisible();
    const [row] = await dbQuery<{ status: string; created_by: string }>("select status, created_by::text as created_by from public.broadcasts");
    expect(row).toEqual({ status: "draft", created_by: ADMIN.id });

    // 編集
    const edit = card(page, "本文の編集");
    await edit.getByLabel("本文").fill("【E2E】臨時休業のお知らせです（編集後）。");
    await edit.getByRole("button", { name: "本文を保存" }).click();
    await expect(card(page, "プレビュー（LINE での見え方の目安）").getByText("【E2E】臨時休業のお知らせです（編集後）。")).toBeVisible();

    // 送信系のボタンは押せない。テスト送信前は配信の欄が出ない
    await expect(card(page, "1. テスト送信（オーナーの LINE にだけ届きます）").getByRole("button", { name: "オーナーにテスト送信" })).toBeDisabled();
    await expect(page.getByText("配信するには、先にテスト送信をして内容を確認してください。")).toBeVisible();
    await expect(page.getByRole("button", { name: "友だち全員に配信する" })).toHaveCount(0);

    // 削除：チェックなしは拒否、チェックありで一覧へ
    const del = card(page, "削除");
    await del.getByRole("button", { name: "削除" }).click();
    await expect(del.locator('p[role="alert"]')).toContainText("「削除する」にチェック");
    await del.getByLabel("削除する（元に戻せません）").check();
    await del.getByRole("button", { name: "削除" }).click();
    await expect(page).toHaveURL(/\/admin\/broadcasts$/);
    await expect(page.getByText("まだ配信はありません。")).toBeVisible();
    expect(await dbQuery("select count(*)::int as n from public.broadcasts")).toEqual([{ n: 0 }]);
  });

  test("テスト送信済みの配信でも、送信が無効なら配信できない（送信可能数の確認もしない）", async ({ page }) => {
    // テスト送信済みの状態を偽の DB に用意する
    const [{ id }] = await dbQuery<{ id: string }>(
      `insert into public.broadcasts (body, created_by) values ('【E2E】テスト送信済み', '${ADMIN.id}') returning id`,
    );
    await dbQuery("update public.broadcasts set status = 'tested', tested_at = now() where id = $1", [id]);

    await login(page, ADMIN, `/admin/broadcasts/${id}`);
    const send = card(page, "2. 配信（友だち全員に送ります）");
    await expect(send.getByText(/LINE への送信は無効になっています/)).toBeVisible();
    await expect(send.getByRole("button", { name: "友だち全員に配信する" })).toBeDisabled();
    expect(await dbQuery("select status from public.broadcasts where id = $1", [id])).toEqual([{ status: "tested" }]);
  });

  test("存在しない配信・不正な ID は「見つかりませんでした」", async ({ page }) => {
    await login(page, ADMIN, "/admin/broadcasts/not-a-uuid");
    await expect(page.getByText("配信が見つかりませんでした。")).toBeVisible();
    await page.goto("/admin/broadcasts/00000000-0000-4000-8000-000000000000");
    await expect(page.getByText("配信が見つかりませんでした。")).toBeVisible();
  });
});
