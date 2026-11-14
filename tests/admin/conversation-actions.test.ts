import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionClient } from "@/lib/admin/auth-core";
import { SAVE_FAILED } from "@/lib/admin/action-state";
import { WRITE_DISABLED_MESSAGE } from "@/lib/admin/mode";
import { draft, FAQS, fakeModel, MENUS, shopRow } from "../ai/fixtures";
import { ADMIN_ID } from "./fake-session";

/**
 * 会話管理の操作（バッチ 3：対応済み・回答テスト）。DB はモック、AI は fakeModel（実際の Claude API は呼ばない）。
 */
vi.mock("@/lib/admin/repo", () => ({ resolveConversation: vi.fn(async () => true) }));
vi.mock("@/lib/db/shop", () => ({
  getShopSettings: vi.fn(async () => shopRow()),
  listPublishedFaqs: vi.fn(async () => FAQS),
  listPublishedMenus: vi.fn(async () => MENUS),
}));

const repo = await import("@/lib/admin/repo");
const shopDb = await import("@/lib/db/shop");
const { markResolved, runAnswerTest, resetAnswerTestLimiter, ANSWER_TEST_LIMIT_PER_HOUR } = await import(
  "@/lib/admin/conversation-actions"
);
const { jstDayRange } = await vi.importActual<typeof import("@/lib/admin/repo")>("@/lib/admin/repo");

const CONV_ID = "33333333-3333-4333-8333-333333333333";
const db = {} as SessionClient;
const ctx = (writeEnabled = true) => ({
  db,
  user: { id: ADMIN_ID, email: null },
  modes: { writeEnabled, lineSendEnabled: false, answerTestAiEnabled: false },
});
const form = (v: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, x] of Object.entries(v)) fd.set(k, x);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  resetAnswerTestLimiter();
});

describe("対応済みにする", () => {
  it("ログイン中の管理者の名前で、対象の会話を対応済みにする", async () => {
    expect((await markResolved(ctx(), form({ id: CONV_ID }))).status).toBe("success");
    expect(repo.resolveConversation).toHaveBeenCalledWith(db, CONV_ID, ADMIN_ID);
  });

  it("書き込み無効なら DB に触れない", async () => {
    expect(await markResolved(ctx(false), form({ id: CONV_ID }))).toMatchObject({ message: WRITE_DISABLED_MESSAGE });
    expect(repo.resolveConversation).not.toHaveBeenCalled();
  });

  it("不正な id・対応済み・DB エラー", async () => {
    expect((await markResolved(ctx(), form({ id: "x" }))).status).toBe("error");
    vi.mocked(repo.resolveConversation).mockResolvedValueOnce(false);
    expect((await markResolved(ctx(), form({ id: CONV_ID }))).status).toBe("error");
    vi.mocked(repo.resolveConversation).mockRejectedValueOnce(new Error("db"));
    expect(await markResolved(ctx(), form({ id: CONV_ID }))).toMatchObject({ message: SAVE_FAILED });
  });
});

describe("回答テスト", () => {
  it("AI を呼ばない設定（既定）：事前判定だけを表示し、モデルは使わない", async () => {
    const r = await runAnswerTest(ctx(), form({ question: "カットはいくら？" }), { model: null });
    expect(r).toMatchObject({ status: "done", aiCalled: false, result: { status: "error", code: "ai_not_configured" } });
    expect(r.status === "done" && r.note).toMatch(/AI は呼び出していません/);
  });

  it("AI を呼ぶ設定：回答とコード側の確認の結果を表示する（モックの AI）", async () => {
    const { model, generate } = fakeModel(draft({ answer: "カットは 4,400円です。", category: "price", menu_refs: ["M1"] }));
    const r = await runAnswerTest(ctx(), form({ question: "カットはいくら？" }), { model, now: () => 0 });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "done", aiCalled: true, result: { status: "answered", replyText: "カットは 4,400円です。" } });
  });

  it("登録外の金額は回答テストでも不採用になる（本番と同じ確認）", async () => {
    const { model } = fakeModel(draft({ answer: "カットは 3,000円です。", category: "price", menu_refs: ["M1"] }));
    const r = await runAnswerTest(ctx(), form({ question: "カットはいくら？" }), { model, now: () => 0 });
    expect(r).toMatchObject({ status: "done", result: { status: "cannot_answer", needsOwner: true } });
  });

  it(`AI を呼ぶのは 1 時間に ${ANSWER_TEST_LIMIT_PER_HOUR} 回まで（費用の暴走防止）`, async () => {
    const { model, generate } = fakeModel(draft({ answer: "営業時間は 10 時からです。", category: "hours", shop_refs: ["S:business_hours"] }));
    for (let i = 0; i < ANSWER_TEST_LIMIT_PER_HOUR; i++) {
      await runAnswerTest(ctx(), form({ question: "営業時間は？" }), { model, now: () => 1_000 });
    }
    const r = await runAnswerTest(ctx(), form({ question: "営業時間は？" }), { model, now: () => 2_000 });
    expect(generate).toHaveBeenCalledTimes(ANSWER_TEST_LIMIT_PER_HOUR);
    expect(r).toMatchObject({ status: "done", aiCalled: false });
    expect(r.status === "done" && r.note).toMatch(/上限/);
    // 1 時間たてば再び呼べる
    const later = await runAnswerTest(ctx(), form({ question: "営業時間は？" }), { model, now: () => 3_602_000 });
    expect(later).toMatchObject({ aiCalled: true });
  });

  it("空の質問はエラー。登録情報を読めなければエラー", async () => {
    expect(await runAnswerTest(ctx(), form({ question: "  " }), { model: null })).toMatchObject({ status: "error" });
    vi.mocked(shopDb.getShopSettings).mockRejectedValueOnce(new Error("db"));
    expect(await runAnswerTest(ctx(), form({ question: "a" }), { model: null })).toMatchObject({ status: "error" });
  });

  it("登録情報が空なら AI を呼ばない（本番と同じ）", async () => {
    vi.mocked(shopDb.listPublishedFaqs).mockResolvedValueOnce([]);
    vi.mocked(shopDb.listPublishedMenus).mockResolvedValueOnce([]);
    vi.mocked(shopDb.getShopSettings).mockResolvedValueOnce(
      shopRow({ shop_name: "", business_hours: "", regular_holidays: "", address: "", phone: "", parking: "", reservation_guide: "", temporary_notice: "" }),
    );
    const { model, generate } = fakeModel(draft());
    const r = await runAnswerTest(ctx(), form({ question: "a" }), { model });
    expect(generate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: "done", result: { code: "no_knowledge" } });
  });
});

describe("会話ログの日付の絞り込み（日本時間）", () => {
  it("日本時間の 0 時〜翌 0 時を UTC で返す", () => {
    expect(jstDayRange("2026-11-12")).toEqual({ from: "2026-11-11T15:00:00.000Z", to: "2026-11-12T15:00:00.000Z" });
  });
  it.each(["2026-13-01", "2026/11/12", "x", "2026-11-12' or 1=1"])("不正な日付 %s は null", (d) => {
    expect(jstDayRange(d)).toBeNull();
  });
});
