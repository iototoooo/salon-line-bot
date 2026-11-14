import { expect, type Page, test as base } from "@playwright/test";

/**
 * ブラウザ自動テストの共通部品。接続先はローカルの偽の Supabase（e2e/fake-supabase.mjs）だけ。
 * アカウントはテスト専用のダミー（実在しないドメイン .test）。
 */
export const FAKE_URL = "http://127.0.0.1:54329";
export const ADMIN = { id: "e2e00000-0000-4000-8000-000000000001", email: "admin@e2e.test", password: "e2e-admin-password" };
export const NON_ADMIN = { email: "staff@e2e.test", password: "e2e-staff-password" };
export const CONV = {
  notifiedUnresolved: "e2e00000-0000-4000-8000-0000000000c1",
  unresolved: "e2e00000-0000-4000-8000-0000000000c2",
  answered: "e2e00000-0000-4000-8000-0000000000c3",
};

/** 偽の DB を直接読む（検証用）。本番には接続しない */
export async function dbQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await fetch(`${FAKE_URL}/__e2e/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`fake db query failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { rows: T[] }).rows;
}

export async function resetDb() {
  const res = await fetch(`${FAKE_URL}/__e2e/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`fake db reset failed: ${res.status}`);
}

export async function login(page: Page, user = ADMIN, next?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  await page.getByLabel("メールアドレス").fill(user.email);
  await page.getByLabel("パスワード").fill(user.password);
  await page.getByRole("button", { name: "ログイン" }).click();
}

/**
 * フォームの結果メッセージ（StatusMessage の <p>）。
 * Next.js の画面遷移の読み上げ用要素（role="alert"）と区別するため、<p> に限定する
 */
export const formError = (page: Page) => page.locator('p[role="alert"]');
export const formSuccess = (page: Page) => page.locator('p[role="status"]');

/** 見出しで管理画面のカード（<section>）を特定する */
export const card = (page: Page, title: string) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

/** 各テストの前に DB を初期状態に戻し、テストの後にデータを残さない */
export const test = base.extend<{ fresh: void }>({
  fresh: [
    async ({}, use) => {
      await resetDb();
      await use();
      await resetDb();
    },
    { auto: true },
  ],
});

export { expect };
