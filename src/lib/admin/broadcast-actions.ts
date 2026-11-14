import type { BroadcastStatusStore } from "@/lib/db/broadcasts";
import { type LinePushClient, LineApiError } from "@/lib/line/client";
import type { LineBroadcastApi } from "@/lib/line/broadcast-client";
import type { BroadcastRow } from "@/types/database";
import { type ActionState, fail, ok, SAVE_FAILED } from "./action-state";
import type { AdminActionContext } from "./data-actions";
import { LINE_SEND_DISABLED_MESSAGE, WRITE_DISABLED_MESSAGE } from "./mode";
import * as repo from "./repo";
import { BROADCAST_CONFIRMATION, validateBroadcastBody, validateId } from "./validation";

/**
 * 一斉配信（バッチ 4・WBS 3.6・要件 F-31〜F-38）。Next.js に依存しない本体（テスト対象）。
 *
 * 誤送信・二重送信の防止（設計書 7.2）
 * - 下書き → テスト送信（オーナーの LINE にだけ push）→ 確認画面 → 確認文言「配信する」の入力 → 配信
 * - 配信直前にサーバー側で送信可能数を取り直し、「配信対象 > 残り送信可能数」なら送らない（画面の数字は信用しない）
 * - DB の送信権（start_broadcast_sending：tested/failed → sending の条件付き更新。同時に 1 件だけ）を取れたときだけ送る
 * - LINE の X-Line-Retry-Key に配信ごとの retry_key を使う。成否不明で再送しても、受理済みなら LINE が 409 を返し二重に届かない
 *   （キーの有効期間は 24 時間のため、成否不明から 23 時間を過ぎた配信は再送させない）
 * - 安全スイッチ：書き込み（ADMIN_WRITE_MODE）と LINE 送信（LINE_BROADCAST_MODE）の両方が有効なときだけ送る
 */

export type BroadcastDeps = {
  /** null：アクセストークン未設定（送信数を確認できない・送れない） */
  api: LineBroadcastApi | null;
  /** テスト送信用。null なら送れない */
  push: LinePushClient | null;
  /** 状態の変更（service_role）。null ならサーバーの接続設定がない */
  store: BroadcastStatusStore | null;
  newRetryKey: () => string;
  now: () => number;
};

const NOT_FOUND = "配信が見つかりませんでした。画面を再読み込みしてください。";
const LINE_USER_ID = /^U[0-9a-f]{32}$/;
/** start_broadcast_sending に渡す「上限なし」の値（プランに上限がない場合） */
const UNLIMITED = 2_147_483_647;
/** 成否不明の配信を同じ再送キーで送り直せる期限（LINE の再送キーは 24 時間有効） */
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
export const UNKNOWN_RESULT_CODE = "broadcast_result_unknown";

// ---------------------------------------------------------------------------
// 下書き（F-31）
// ---------------------------------------------------------------------------
export async function createDraft(ctx: AdminActionContext, fd: FormData): Promise<ActionState & { id?: string }> {
  if (!ctx.modes.writeEnabled) return fail(WRITE_DISABLED_MESSAGE);
  const v = validateBroadcastBody(fd);
  if (!v.ok) return fail("入力内容に誤りがあります。", v.errors);
  try {
    const id = await repo.createBroadcastDraft(ctx.db, v.value.body);
    return { ...ok("下書きを保存しました。次にテスト送信をしてください。"), id };
  } catch {
    return fail(SAVE_FAILED);
  }
}

export async function updateDraft(ctx: AdminActionContext, fd: FormData): Promise<ActionState> {
  if (!ctx.modes.writeEnabled) return fail(WRITE_DISABLED_MESSAGE);
  const id = validateId(fd);
  if (!id) return fail(NOT_FOUND);
  const v = validateBroadcastBody(fd);
  if (!v.ok) return fail("入力内容に誤りがあります。", v.errors);
  try {
    return (await repo.updateBroadcastBody(ctx.db, id, v.value.body))
      ? ok("本文を保存しました。本文を変えたため、もう一度テスト送信が必要です。")
      : fail("送信中・送信済みの配信は変更できません。");
  } catch {
    return fail(SAVE_FAILED);
  }
}

export async function deleteDraft(ctx: AdminActionContext, fd: FormData): Promise<ActionState> {
  if (!ctx.modes.writeEnabled) return fail(WRITE_DISABLED_MESSAGE);
  const id = validateId(fd);
  if (!id) return fail(NOT_FOUND);
  if (fd.get("confirm_delete") !== "on") return fail("削除する場合は「削除する」にチェックを入れてください。");
  try {
    return (await repo.deleteBroadcast(ctx.db, id)) ? ok("下書きを削除しました。") : fail("送信中・送信済み・失敗した配信は削除できません。");
  } catch {
    return fail(SAVE_FAILED);
  }
}

// ---------------------------------------------------------------------------
// 送信可能数の確認（F-34・F-35）
// ---------------------------------------------------------------------------
export type SendPreview =
  | {
      ok: true;
      /** 配信対象の目安（前日時点の LINE の集計） */
      recipients: number;
      /** 今月の残り送信可能数。null は上限なし */
      remaining: number | null;
      /** 配信後の残り見込み */
      after: number | null;
      enough: boolean;
    }
  | { ok: false; reason: string };

/** 日本時間の前日（YYYYMMDD）。友だち数は前日分まで集計される */
export function yesterdayJst(now: number): string {
  const d = new Date(now + 9 * 3_600_000 - 86_400_000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function loadSendPreview(api: LineBroadcastApi | null, now: number): Promise<SendPreview> {
  if (!api) return { ok: false, reason: "LINE のアクセストークンが設定されていないため、送信可能数を確認できません。" };
  try {
    const [quota, used, followers] = await Promise.all([api.getQuota(), api.getConsumption(), api.getFollowers(yesterdayJst(now))]);
    const recipients =
      followers.status === "ready"
        ? (followers.targetedReaches ?? (followers.followers !== null ? followers.followers - (followers.blocks ?? 0) : null))
        : null;
    if (recipients === null || recipients < 0) {
      return { ok: false, reason: "友だち数を確認できません（LINE で集計中の可能性があります）。時間をおいて再度お試しください。" };
    }
    const remaining = quota.type === "none" ? null : Math.max(0, quota.value - used);
    return {
      ok: true,
      recipients,
      remaining,
      after: remaining === null ? null : remaining - recipients,
      enough: remaining === null || recipients <= remaining,
    };
  } catch {
    return { ok: false, reason: "LINE から送信可能数を取得できませんでした。時間をおいて再度お試しください。" };
  }
}

// ---------------------------------------------------------------------------
// テスト送信（F-33：オーナーの LINE にだけ）
// ---------------------------------------------------------------------------
export async function sendTest(ctx: AdminActionContext, fd: FormData, deps: BroadcastDeps): Promise<ActionState> {
  if (!ctx.modes.writeEnabled) return fail(WRITE_DISABLED_MESSAGE);
  if (!ctx.modes.lineSendEnabled || !deps.push) return fail(LINE_SEND_DISABLED_MESSAGE);
  if (!deps.store) return fail("サーバーの接続設定がないため、テスト送信の記録ができません。");
  const id = validateId(fd);
  if (!id) return fail(NOT_FOUND);

  let b: BroadcastRow | null;
  let ownerId: string | null;
  try {
    [b, ownerId] = await Promise.all([repo.getBroadcast(ctx.db, id), repo.getShop(ctx.db).then((s) => s.owner_line_user_id)]);
  } catch {
    return fail(SAVE_FAILED);
  }
  if (!b) return fail(NOT_FOUND);
  if (b.status !== "draft" && b.status !== "tested") return fail("この配信はテスト送信できません（送信中・送信済み・失敗）。");
  if (!ownerId || !LINE_USER_ID.test(ownerId)) {
    return fail("オーナーの通知先（LINE ユーザー ID）が設定されていません。「店舗情報・設定」で登録してください。");
  }

  try {
    // 宛先はオーナーだけ（お客様には送らない）。1 回の push で 2 通にまとめても、送信数は 1 通として数えられる
    await deps.push.push(
      ownerId,
      [
        { type: "text", text: "【テスト送信】次の内容を友だち全員に配信する予定です。" },
        { type: "text", text: b.body },
      ],
      deps.newRetryKey(),
    );
  } catch (err) {
    const code = err instanceof LineApiError ? `（LINE のエラー ${err.status}）` : "";
    return fail(`テスト送信に失敗しました${code}。オーナーの LINE で公式アカウントを友だち追加しているか確認してください。`);
  }
  try {
    await deps.store.markTested(id);
  } catch {
    return fail("テスト送信はしましたが、記録に失敗しました。画面を再読み込みしてから、もう一度テスト送信してください。");
  }
  return ok("オーナーの LINE にテスト送信しました。内容を確認してから配信してください。");
}

// ---------------------------------------------------------------------------
// 配信（F-34〜F-38）
// ---------------------------------------------------------------------------
export async function sendBroadcast(ctx: AdminActionContext, fd: FormData, deps: BroadcastDeps): Promise<ActionState> {
  if (!ctx.modes.writeEnabled) return fail(WRITE_DISABLED_MESSAGE);
  if (!ctx.modes.lineSendEnabled || !deps.api) return fail(LINE_SEND_DISABLED_MESSAGE);
  if (!deps.store) return fail("サーバーの接続設定がないため、配信できません。");
  const id = validateId(fd);
  if (!id) return fail(NOT_FOUND);
  if (String(fd.get("confirmation") ?? "").trim() !== BROADCAST_CONFIRMATION) {
    return fail(`確認のため「${BROADCAST_CONFIRMATION}」と入力してください。`, {
      confirmation: `「${BROADCAST_CONFIRMATION}」と入力してください。`,
    });
  }

  let b: BroadcastRow | null;
  try {
    b = await repo.getBroadcast(ctx.db, id);
  } catch {
    return fail(SAVE_FAILED);
  }
  if (!b) return fail(NOT_FOUND);
  if (b.status !== "tested" && b.status !== "failed") return fail("テスト送信が済んでいない、または送信中・送信済みの配信です。");
  if (!b.tested_at) return fail("先にテスト送信をしてください。");
  if (b.status === "failed" && b.error_message === UNKNOWN_RESULT_CODE && b.sending_started_at) {
    const elapsed = deps.now() - new Date(b.sending_started_at).getTime();
    if (elapsed > RETRY_WINDOW_MS) {
      return fail(
        "前回の配信から 23 時間以上たっているため、二重配信を防げません。LINE 公式アカウントの管理画面で配信されたかを確認し、必要なら新しい下書きを作ってください。",
      );
    }
  }

  // 画面の数字は使わず、配信直前に取り直す
  const preview = await loadSendPreview(deps.api, deps.now());
  if (!preview.ok) return fail(preview.reason);
  if (!preview.enough) {
    return fail(`今月の残り送信可能数（${preview.remaining} 通）が配信対象（${preview.recipients} 人）より少ないため配信できません。`);
  }

  // 送信権の取得（同時に 1 件・tested/failed からのみ）。取れなければ送らない
  let row: BroadcastRow;
  try {
    row = await deps.store.startSending(id, preview.recipients, preview.remaining ?? UNLIMITED);
  } catch {
    return fail("配信を開始できませんでした（別の配信が送信中、またはすでに送信済みの可能性があります）。画面を再読み込みしてください。");
  }

  try {
    await deps.api.broadcast([{ type: "text", text: row.body }], row.retry_key);
  } catch (err) {
    if (err instanceof LineApiError && err.status >= 400 && err.status < 500) {
      await deps.store.markFailed(id, `broadcast_http_${err.status}`).catch(() => undefined);
      return fail(`LINE が配信を受け付けませんでした（エラー ${err.status}）。送信数の上限や本文を確認してください。`);
    }
    await deps.store.markFailed(id, UNKNOWN_RESULT_CODE).catch(() => undefined);
    return fail(
      "配信の結果が確認できませんでした。LINE 公式アカウントの管理画面で配信されたかを確認してください。再度「配信する」を押しても、同じ配信が二重に届くことはありません（23 時間以内）。",
    );
  }

  try {
    await deps.store.markSent(id);
  } catch {
    return ok("配信しました（記録の更新に失敗したため、履歴の表示が「送信中」のままの場合があります）。");
  }
  return ok(`配信しました（対象の目安 ${preview.recipients} 人）。`);
}
