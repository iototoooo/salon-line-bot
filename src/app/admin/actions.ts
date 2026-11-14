"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/admin/action-state";
import * as core from "@/lib/admin/data-actions";
import { readAdminModes } from "@/lib/admin/mode";
import { requireAdmin } from "@/lib/admin/session";

/**
 * 管理画面のデータ管理の Server Action（バッチ 2）。
 * どれも先頭で requireAdmin（ログイン・管理者）を確認し、本体は src/lib/admin/data-actions.ts。
 * 画面に表示されていない状態でも直接呼ばれうるため、権限・書き込み可否・入力はサーバー側で必ず確認する。
 */
type Core = (ctx: core.AdminActionContext, fd: FormData) => Promise<ActionState>;

async function run(fn: Core, fd: FormData, paths: string[]): Promise<ActionState> {
  const { db, user } = await requireAdmin();
  const result = await fn({ db, user, modes: readAdminModes() }, fd);
  if (result.status === "success") for (const p of paths) revalidatePath(p);
  return result;
}

export async function saveFaqAction(_: ActionState, fd: FormData) {
  return run(core.saveFaq, fd, ["/admin/faqs", "/admin"]);
}
export async function toggleFaqPublishedAction(_: ActionState, fd: FormData) {
  return run(core.toggleFaqPublished, fd, ["/admin/faqs", "/admin"]);
}
export async function removeFaqAction(_: ActionState, fd: FormData) {
  return run(core.removeFaq, fd, ["/admin/faqs", "/admin"]);
}
export async function saveMenuAction(_: ActionState, fd: FormData) {
  return run(core.saveMenu, fd, ["/admin/menus", "/admin"]);
}
export async function toggleMenuPublishedAction(_: ActionState, fd: FormData) {
  return run(core.toggleMenuPublished, fd, ["/admin/menus", "/admin"]);
}
export async function removeMenuAction(_: ActionState, fd: FormData) {
  return run(core.removeMenu, fd, ["/admin/menus", "/admin"]);
}
export async function saveShopInfoAction(_: ActionState, fd: FormData) {
  return run(core.saveShopInfo, fd, ["/admin/settings"]);
}
export async function changeBotEnabledAction(_: ActionState, fd: FormData) {
  return run(core.changeBotEnabled, fd, ["/admin/settings", "/admin"]);
}
export async function saveOwnerLineUserIdAction(_: ActionState, fd: FormData) {
  return run(core.saveOwnerLineUserId, fd, ["/admin/settings", "/admin"]);
}
