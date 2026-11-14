import { type ActionState, fail, ok, SAVE_FAILED } from "./action-state";
import type { AdminUser, SessionClient } from "./auth-core";
import { type AdminModes, WRITE_DISABLED_MESSAGE } from "./mode";
import * as repo from "./repo";
import {
  validateBotToggle,
  validateFaq,
  validateId,
  validateMenu,
  validateOwnerLineUserId,
  validateShopInfo,
} from "./validation";

/**
 * 管理画面のデータ管理の操作（バッチ 2：FAQ・メニュー・店舗情報・自動応答 ON/OFF・通知先）。
 * Next.js に依存しない本体（テスト対象）。呼び出し側（Server Action）は requireAdmin で ctx を作ってから呼ぶ。
 *
 * 共通のルール
 * - 書き込み無効（ADMIN_WRITE_MODE が enabled でない）なら、入力チェックの前に拒否し DB に触れない
 * - 入力は DB の制約と同じ条件で検証し、項目ごとの日本語エラーを返す
 * - DB エラーの内容は画面に出さない（定型文）
 */
export type AdminActionContext = { db: SessionClient; user: AdminUser; modes: AdminModes };

const NOT_FOUND = "対象が見つかりませんでした（削除された可能性があります）。画面を再読み込みしてください。";
const INVALID = "入力内容に誤りがあります。赤字の項目を確認してください。";

async function guarded(ctx: AdminActionContext, run: () => Promise<ActionState>): Promise<ActionState> {
  if (!ctx.modes.writeEnabled) return fail(WRITE_DISABLED_MESSAGE);
  try {
    return await run();
  } catch {
    return fail(SAVE_FAILED);
  }
}

// ---------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------
export function saveFaq(ctx: AdminActionContext, fd: FormData): Promise<ActionState> {
  return guarded(ctx, async () => {
    const v = validateFaq(fd);
    if (!v.ok) return fail(INVALID, v.errors);
    const rawId = fd.get("id");
    if (rawId === null || rawId === "") {
      await repo.createFaq(ctx.db, v.value);
      return ok("FAQ を追加しました。");
    }
    const id = validateId(fd);
    if (!id) return fail(NOT_FOUND);
    return (await repo.updateFaq(ctx.db, id, v.value)) ? ok("FAQ を保存しました。") : fail(NOT_FOUND);
  });
}

export function toggleFaqPublished(ctx: AdminActionContext, fd: FormData): Promise<ActionState> {
  return guarded(ctx, async () => {
    const id = validateId(fd);
    if (!id) return fail(NOT_FOUND);
    const published = fd.get("published") === "true";
    return (await repo.setFaqPublished(ctx.db, id, published))
      ? ok(published ? "公開しました（AI の回答に使われます）。" : "非公開にしました（AI の回答に使われません）。")
      : fail(NOT_FOUND);
  });
}

export function removeFaq(ctx: AdminActionContext, fd: FormData): Promise<ActionState> {
  return guarded(ctx, async () => {
    const id = validateId(fd);
    if (!id) return fail(NOT_FOUND);
    if (fd.get("confirm_delete") !== "on") return fail("削除する場合は「削除する」にチェックを入れてください。");
    return (await repo.deleteFaq(ctx.db, id)) ? ok("FAQ を削除しました。") : fail(NOT_FOUND);
  });
}

// ---------------------------------------------------------------------------
// メニュー・料金
// ---------------------------------------------------------------------------
export function saveMenu(ctx: AdminActionContext, fd: FormData): Promise<ActionState> {
  return guarded(ctx, async () => {
    const v = validateMenu(fd);
    if (!v.ok) return fail(INVALID, v.errors);
    const rawId = fd.get("id");
    if (rawId === null || rawId === "") {
      await repo.createMenu(ctx.db, v.value);
      return ok("メニューを追加しました。");
    }
    const id = validateId(fd);
    if (!id) return fail(NOT_FOUND);
    return (await repo.updateMenu(ctx.db, id, v.value)) ? ok("メニューを保存しました（次のお問い合わせから反映）。") : fail(NOT_FOUND);
  });
}

export function toggleMenuPublished(ctx: AdminActionContext, fd: FormData): Promise<ActionState> {
  return guarded(ctx, async () => {
    const id = validateId(fd);
    if (!id) return fail(NOT_FOUND);
    const published = fd.get("published") === "true";
    return (await repo.setMenuPublished(ctx.db, id, published))
      ? ok(published ? "公開しました（AI の回答に使われます）。" : "非公開にしました（AI の回答に使われません）。")
      : fail(NOT_FOUND);
  });
}

export function removeMenu(ctx: AdminActionContext, fd: FormData): Promise<ActionState> {
  return guarded(ctx, async () => {
    const id = validateId(fd);
    if (!id) return fail(NOT_FOUND);
    if (fd.get("confirm_delete") !== "on") return fail("削除する場合は「削除する」にチェックを入れてください。");
    return (await repo.deleteMenu(ctx.db, id)) ? ok("メニューを削除しました。") : fail(NOT_FOUND);
  });
}

// ---------------------------------------------------------------------------
// 店舗情報・自動応答 ON/OFF・通知先
// ---------------------------------------------------------------------------
export function saveShopInfo(ctx: AdminActionContext, fd: FormData): Promise<ActionState> {
  return guarded(ctx, async () => {
    const v = validateShopInfo(fd);
    if (!v.ok) return fail(INVALID, v.errors);
    return (await repo.updateShopInfo(ctx.db, v.value)) ? ok("店舗情報を保存しました（次のお問い合わせから反映）。") : fail(SAVE_FAILED);
  });
}

export function changeBotEnabled(ctx: AdminActionContext, fd: FormData): Promise<ActionState> {
  return guarded(ctx, async () => {
    const v = validateBotToggle(fd);
    if (!v.ok) return fail(INVALID, v.errors);
    if (!(await repo.setBotEnabled(ctx.db, v.value.bot_enabled))) return fail(SAVE_FAILED);
    return ok(
      v.value.bot_enabled
        ? "自動応答を ON にしました。AI が登録情報をもとに回答します。"
        : "自動応答を OFF にしました。AI は使わず、定型文だけを返します。",
    );
  });
}

export function saveOwnerLineUserId(ctx: AdminActionContext, fd: FormData): Promise<ActionState> {
  return guarded(ctx, async () => {
    const v = validateOwnerLineUserId(fd);
    if (!v.ok) return fail(INVALID, v.errors);
    if (!(await repo.setOwnerLineUserId(ctx.db, v.value.owner_line_user_id))) return fail(SAVE_FAILED);
    return ok(
      v.value.owner_line_user_id
        ? "通知先を保存しました。LINE 公式アカウントを友だち追加していないと通知は届きません。"
        : "通知先を解除しました。通知は送られず、未対応一覧にだけ表示されます。",
    );
  });
}
