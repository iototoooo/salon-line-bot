import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionClient } from "@/lib/admin/auth-core";
import { SAVE_FAILED } from "@/lib/admin/action-state";
import { WRITE_DISABLED_MESSAGE } from "@/lib/admin/mode";
import { BOT_TOGGLE_CONFIRMATION, validateBroadcastBody, validateFaq, validateMenu, validateShopInfo } from "@/lib/admin/validation";
import { ADMIN_ID } from "./fake-session";

/**
 * データ管理の操作（バッチ 2）。DB 操作（repo）はモックし、実際の Supabase には接続しない。
 * 権限そのもの（RLS・列の権限）は tests/db/admin-screens.sql.test.ts（PGlite）で確認する。
 */
vi.mock("@/lib/admin/repo", () => ({
  createFaq: vi.fn(async () => undefined),
  updateFaq: vi.fn(async () => true),
  setFaqPublished: vi.fn(async () => true),
  deleteFaq: vi.fn(async () => true),
  createMenu: vi.fn(async () => undefined),
  updateMenu: vi.fn(async () => true),
  setMenuPublished: vi.fn(async () => true),
  deleteMenu: vi.fn(async () => true),
  updateShopInfo: vi.fn(async () => true),
  setBotEnabled: vi.fn(async () => true),
  setOwnerLineUserId: vi.fn(async () => true),
}));

const repo = await import("@/lib/admin/repo");
const core = await import("@/lib/admin/data-actions");

const FAQ_ID = "22222222-2222-4222-8222-222222222222";
const db = {} as SessionClient;
const ctx = (writeEnabled = true): Parameters<typeof core.saveFaq>[0] => ({
  db,
  user: { id: ADMIN_ID, email: null },
  modes: { writeEnabled, lineSendEnabled: false, answerTestAiEnabled: false },
});
const form = (v: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, x] of Object.entries(v)) fd.set(k, x);
  return fd;
};
const faqForm = (over: Record<string, string> = {}) =>
  form({ question: "駐車場はありますか？", answer: "2台あります。", category: "access", sort_order: "1", is_published: "on", ...over });

beforeEach(() => vi.clearAllMocks());

describe("書き込み無効（既定）", () => {
  it.each([
    ["saveFaq", () => core.saveFaq(ctx(false), faqForm())],
    ["removeFaq", () => core.removeFaq(ctx(false), form({ id: FAQ_ID, confirm_delete: "on" }))],
    ["saveMenu", () => core.saveMenu(ctx(false), form({ name: "カット", category: "cut", price: "4400" }))],
    ["saveShopInfo", () => core.saveShopInfo(ctx(false), form({ fallback_message: "確認します" }))],
    ["changeBotEnabled", () => core.changeBotEnabled(ctx(false), form({ bot_enabled: "true", confirmation: BOT_TOGGLE_CONFIRMATION }))],
    ["saveOwnerLineUserId", () => core.saveOwnerLineUserId(ctx(false), form({ owner_line_user_id: `U${"a".repeat(32)}` }))],
  ])("%s は DB に触れずに拒否する", async (_l, run) => {
    expect(await run()).toEqual({ status: "error", message: WRITE_DISABLED_MESSAGE, fieldErrors: undefined });
    for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("FAQ", () => {
  it("id がなければ追加、あれば更新", async () => {
    expect((await core.saveFaq(ctx(), faqForm())).status).toBe("success");
    expect(repo.createFaq).toHaveBeenCalledWith(db, {
      question: "駐車場はありますか？",
      answer: "2台あります。",
      category: "access",
      is_published: true,
      sort_order: 1,
    });
    expect((await core.saveFaq(ctx(), faqForm({ id: FAQ_ID }))).status).toBe("success");
    expect(repo.updateFaq).toHaveBeenCalledWith(db, FAQ_ID, expect.objectContaining({ question: "駐車場はありますか？" }));
  });

  it("入力エラーは項目ごとに返し、DB に触れない", async () => {
    const r = await core.saveFaq(ctx(), faqForm({ question: "", category: "xxx" }));
    expect(r).toMatchObject({ status: "error", fieldErrors: { question: "入力してください。", category: "分類を選んでください。" } });
    expect(repo.createFaq).not.toHaveBeenCalled();
  });

  it("不正な id・見つからない場合はエラー", async () => {
    expect((await core.saveFaq(ctx(), faqForm({ id: "1; drop table faqs" }))).status).toBe("error");
    vi.mocked(repo.updateFaq).mockResolvedValueOnce(false);
    expect((await core.saveFaq(ctx(), faqForm({ id: FAQ_ID }))).status).toBe("error");
  });

  it("削除は「削除する」のチェックが必須", async () => {
    expect((await core.removeFaq(ctx(), form({ id: FAQ_ID }))).status).toBe("error");
    expect(repo.deleteFaq).not.toHaveBeenCalled();
    expect((await core.removeFaq(ctx(), form({ id: FAQ_ID, confirm_delete: "on" }))).status).toBe("success");
  });

  it("DB エラーは内容を出さずに定型文", async () => {
    vi.mocked(repo.createFaq).mockRejectedValueOnce(new Error("db: insert failed (23514) secret detail"));
    expect(await core.saveFaq(ctx(), faqForm())).toEqual({ status: "error", message: SAVE_FAILED, fieldErrors: undefined });
  });

  it("公開・非公開の切り替え", async () => {
    await core.toggleFaqPublished(ctx(), form({ id: FAQ_ID, published: "false" }));
    expect(repo.setFaqPublished).toHaveBeenCalledWith(db, FAQ_ID, false);
  });
});

describe("メニュー・料金", () => {
  it("料金は全角数字・カンマも整数として受け付ける", async () => {
    await core.saveMenu(ctx(), form({ name: "カラー", category: "color", price: "６，６００", duration_min: "90", is_published: "on" }));
    expect(repo.createMenu).toHaveBeenCalledWith(db, expect.objectContaining({ price: 6600, duration_min: 90, is_published: true }));
  });
});

describe("自動応答 ON/OFF", () => {
  it("確認の文言がなければ変更しない", async () => {
    const r = await core.changeBotEnabled(ctx(), form({ bot_enabled: "true", confirmation: "はい" }));
    expect(r.status).toBe("error");
    expect(repo.setBotEnabled).not.toHaveBeenCalled();
  });

  it("確認の文言があれば変更する", async () => {
    expect((await core.changeBotEnabled(ctx(), form({ bot_enabled: "false", confirmation: ` ${BOT_TOGGLE_CONFIRMATION} ` }))).status).toBe("success");
    expect(repo.setBotEnabled).toHaveBeenCalledWith(db, false);
  });
});

describe("オーナー通知先", () => {
  it.each([
    ["形式違い", `U${"a".repeat(31)}`],
    ["大文字", `U${"A".repeat(32)}`],
    ["空欄（解除のチェックなし）", ""],
  ])("%s は保存しない", async (_l, v) => {
    expect((await core.saveOwnerLineUserId(ctx(), form({ owner_line_user_id: v }))).status).toBe("error");
    expect(repo.setOwnerLineUserId).not.toHaveBeenCalled();
  });

  it("正しい ID は保存、解除のチェックで null", async () => {
    const id = `U${"a".repeat(32)}`;
    await core.saveOwnerLineUserId(ctx(), form({ owner_line_user_id: id }));
    expect(repo.setOwnerLineUserId).toHaveBeenLastCalledWith(db, id);
    await core.saveOwnerLineUserId(ctx(), form({ clear: "on" }));
    expect(repo.setOwnerLineUserId).toHaveBeenLastCalledWith(db, null);
  });

  it("成功メッセージに ID を含めない", async () => {
    const id = `U${"a".repeat(32)}`;
    const r = await core.saveOwnerLineUserId(ctx(), form({ owner_line_user_id: id }));
    expect(JSON.stringify(r)).not.toContain(id);
  });
});

describe("入力チェック（DB の制約と同じ条件）", () => {
  it("文字数は改行を \\n にそろえ、絵文字も 1 文字として数える", () => {
    expect(validateFaq(faqForm({ question: "😀".repeat(300) })).ok).toBe(true);
    expect(validateFaq(faqForm({ question: "😀".repeat(301) })).ok).toBe(false);
    expect(validateBroadcastBody(form({ body: "a\r\nb" }))).toEqual({ ok: true, value: { body: "a\nb" } });
  });

  it.each([
    ["料金なし", { price: "" }, "price"],
    ["料金が小数", { price: "4400.5" }, "price"],
    ["料金が上限超え", { price: "1000001" }, "price"],
    ["所要時間 0", { duration_min: "0" }, "duration_min"],
    ["分類が不正", { category: "x" }, "category"],
  ])("メニュー：%s", (_l, over, field) => {
    const r = validateMenu(form({ name: "カット", category: "cut", price: "4400", ...over }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toContain(field);
  });

  it("店舗情報：定型文は必須・電話番号は数字と記号だけ", () => {
    const r = validateShopInfo(form({ fallback_message: "", phone: "電話してね" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["fallback_message", "phone"]);
    expect(validateShopInfo(form({ fallback_message: "確認します", phone: "03-1234-5678" })).ok).toBe(true);
  });

  it("配信本文は 5,000 文字まで・空は不可", () => {
    expect(validateBroadcastBody(form({ body: "" })).ok).toBe(false);
    expect(validateBroadcastBody(form({ body: "あ".repeat(5000) })).ok).toBe(true);
    expect(validateBroadcastBody(form({ body: "あ".repeat(5001) })).ok).toBe(false);
  });
});
