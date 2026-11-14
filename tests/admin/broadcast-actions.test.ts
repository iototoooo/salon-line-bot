import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionClient } from "@/lib/admin/auth-core";
import type { BroadcastDeps } from "@/lib/admin/broadcast-actions";
import { LINE_SEND_DISABLED_MESSAGE, WRITE_DISABLED_MESSAGE } from "@/lib/admin/mode";
import type { BroadcastStatusStore } from "@/lib/db/broadcasts";
import type { LineBroadcastApi } from "@/lib/line/broadcast-client";
import { LineApiError, type LinePushClient } from "@/lib/line/client";
import type { BroadcastRow } from "@/types/database";
import { shopRow } from "../ai/fixtures";
import { ADMIN_ID } from "./fake-session";

/**
 * 一斉配信（バッチ 4）。DB・LINE はすべてモック（実際の送信はしない）。
 */
vi.mock("@/lib/admin/repo", () => ({
  createBroadcastDraft: vi.fn(async () => "44444444-4444-4444-8444-444444444444"),
  updateBroadcastBody: vi.fn(async () => true),
  deleteBroadcast: vi.fn(async () => true),
  getBroadcast: vi.fn(),
  getShop: vi.fn(),
}));

const repo = await import("@/lib/admin/repo");
const core = await import("@/lib/admin/broadcast-actions");

const ID = "44444444-4444-4444-8444-444444444444";
const RETRY = "55555555-5555-4555-8555-555555555555";
const OWNER = `U${"e".repeat(32)}`;
const NOW = Date.parse("2026-11-13T03:00:00Z");
const db = {} as SessionClient;

const row = (over: Partial<BroadcastRow> = {}): BroadcastRow =>
  ({
    id: ID,
    body: "臨時休業のお知らせ",
    status: "tested",
    retry_key: RETRY,
    tested_at: "2026-11-13T02:00:00Z",
    sending_started_at: null,
    sent_at: null,
    error_message: null,
    estimated_recipients: null,
    quota_remaining_before: null,
    created_by: ADMIN_ID,
    created_at: "2026-11-13T01:00:00Z",
    updated_at: "2026-11-13T02:00:00Z",
    ...over,
  }) as BroadcastRow;

const ctx = (modes: Partial<{ writeEnabled: boolean; lineSendEnabled: boolean }> = {}) => ({
  db,
  user: { id: ADMIN_ID, email: null },
  modes: { writeEnabled: true, lineSendEnabled: true, answerTestAiEnabled: false, ...modes },
});
const form = (v: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, x] of Object.entries(v)) fd.set(k, x);
  return fd;
};

function deps(over: { followers?: Partial<Awaited<ReturnType<LineBroadcastApi["getFollowers"]>>>; quota?: number | "none"; used?: number } = {}) {
  const api = {
    getQuota: vi.fn(async () => (over.quota === "none" ? { type: "none" as const } : { type: "limited" as const, value: over.quota ?? 200 })),
    getConsumption: vi.fn(async () => over.used ?? 10),
    getFollowers: vi.fn(async () => ({ status: "ready", followers: 3, targetedReaches: 3, blocks: 0, ...over.followers })),
    broadcast: vi.fn<LineBroadcastApi["broadcast"]>(async () => "sent"),
  };
  const push = { push: vi.fn<LinePushClient["push"]>(async () => "sent") };
  const store = {
    markTested: vi.fn<BroadcastStatusStore["markTested"]>(async () => true),
    startSending: vi.fn<BroadcastStatusStore["startSending"]>(async () => row({ status: "sending" })),
    markSent: vi.fn<BroadcastStatusStore["markSent"]>(async () => true),
    markFailed: vi.fn<BroadcastStatusStore["markFailed"]>(async () => true),
  };
  const d: BroadcastDeps = { api, push, store, newRetryKey: () => "66666666-6666-4666-8666-666666666666", now: () => NOW };
  return { d, api, push, store };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(repo.getBroadcast).mockResolvedValue(row());
  vi.mocked(repo.getShop).mockResolvedValue(shopRow({ owner_line_user_id: OWNER }));
});

describe("下書き", () => {
  it("書き込み無効なら作らない", async () => {
    expect(await core.createDraft(ctx({ writeEnabled: false }), form({ body: "x" }))).toMatchObject({ message: WRITE_DISABLED_MESSAGE });
    expect(repo.createBroadcastDraft).not.toHaveBeenCalled();
  });
  it("作成すると id を返す（確認画面へ移動するため）", async () => {
    expect(await core.createDraft(ctx(), form({ body: "臨時休業" }))).toMatchObject({ status: "success", id: ID });
  });
  it("本文が空なら作らない", async () => {
    expect((await core.createDraft(ctx(), form({ body: " " }))).status).toBe("error");
  });
  it("削除はチェックが必要", async () => {
    expect((await core.deleteDraft(ctx(), form({ id: ID }))).status).toBe("error");
    expect((await core.deleteDraft(ctx(), form({ id: ID, confirm_delete: "on" }))).status).toBe("success");
  });
});

describe("テスト送信（オーナーの LINE にだけ）", () => {
  it("オーナーにだけ push し、テスト送信済みにする", async () => {
    const { d, push, store, api } = deps();
    expect((await core.sendTest(ctx(), form({ id: ID }), d)).status).toBe("success");
    expect(push.push).toHaveBeenCalledTimes(1);
    const [to, messages, key] = push.push.mock.calls[0];
    expect(to).toBe(OWNER);
    expect(messages.map((m) => m.text)).toEqual([expect.stringContaining("【テスト送信】"), "臨時休業のお知らせ"]);
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.markTested).toHaveBeenCalledWith(ID);
    // 一斉配信の API は使わない
    expect(api.broadcast).not.toHaveBeenCalled();
  });

  it.each([
    ["書き込み無効", { writeEnabled: false }, WRITE_DISABLED_MESSAGE],
    ["LINE 送信が無効（既定）", { lineSendEnabled: false }, LINE_SEND_DISABLED_MESSAGE],
  ])("%s なら送らない", async (_l, modes, message) => {
    const { d, push } = deps();
    expect(await core.sendTest(ctx(modes), form({ id: ID }), d)).toMatchObject({ message });
    expect(push.push).not.toHaveBeenCalled();
  });

  it("通知先が未設定・送信中の配信には送らない", async () => {
    const { d, push } = deps();
    vi.mocked(repo.getShop).mockResolvedValueOnce(shopRow({ owner_line_user_id: null }));
    expect((await core.sendTest(ctx(), form({ id: ID }), d)).status).toBe("error");
    vi.mocked(repo.getBroadcast).mockResolvedValueOnce(row({ status: "sending" }));
    expect((await core.sendTest(ctx(), form({ id: ID }), d)).status).toBe("error");
    expect(push.push).not.toHaveBeenCalled();
  });

  it("送信に失敗したらテスト送信済みにしない", async () => {
    const { d, push, store } = deps();
    push.push.mockRejectedValueOnce(new LineApiError(400, "x"));
    expect((await core.sendTest(ctx(), form({ id: ID }), d)).status).toBe("error");
    expect(store.markTested).not.toHaveBeenCalled();
  });
});

describe("送信可能数の確認", () => {
  it("配信対象・残り・配信後の見込みを計算する", async () => {
    const { d } = deps({ quota: 200, used: 10, followers: { targetedReaches: 30 } });
    expect(await core.loadSendPreview(d.api, NOW)).toEqual({ ok: true, recipients: 30, remaining: 190, after: 160, enough: true });
  });
  it("足りなければ enough=false。上限なしのプランは常に足りる", async () => {
    expect(await core.loadSendPreview(deps({ quota: 200, used: 195, followers: { targetedReaches: 30 } }).d.api, NOW)).toMatchObject({ enough: false, after: -25 });
    expect(await core.loadSendPreview(deps({ quota: "none" }).d.api, NOW)).toMatchObject({ enough: true, remaining: null });
  });
  it("友だち数が集計中・取得失敗なら確認できない（配信させない）", async () => {
    expect((await core.loadSendPreview(deps({ followers: { status: "unready" } }).d.api, NOW)).ok).toBe(false);
    const { d, api } = deps();
    api.getQuota.mockRejectedValueOnce(new Error("network"));
    expect((await core.loadSendPreview(d.api, NOW)).ok).toBe(false);
    expect((await core.loadSendPreview(null, NOW)).ok).toBe(false);
  });
  it("友だち数は日本時間の前日分を使う", async () => {
    const { d, api } = deps();
    await core.loadSendPreview(d.api, NOW);
    expect(api.getFollowers).toHaveBeenCalledWith("20261112");
  });
});

describe("配信", () => {
  const send = (over: Record<string, string> = {}) => form({ id: ID, confirmation: "配信する", ...over });

  it("確認文言・送信可能数・送信権がそろったときだけ、配信の再送キーで 1 回送る", async () => {
    const { d, api, store } = deps();
    expect((await core.sendBroadcast(ctx(), send(), d)).status).toBe("success");
    expect(store.startSending).toHaveBeenCalledWith(ID, 3, 190);
    expect(api.broadcast).toHaveBeenCalledWith([{ type: "text", text: "臨時休業のお知らせ" }], RETRY);
    expect(store.markSent).toHaveBeenCalledWith(ID);
  });

  it.each([
    ["書き込み無効", { writeEnabled: false }],
    ["LINE 送信が無効（既定）", { lineSendEnabled: false }],
  ])("%s なら送らない", async (_l, modes) => {
    const { d, api, store } = deps();
    expect((await core.sendBroadcast(ctx(modes), send(), d)).status).toBe("error");
    expect(store.startSending).not.toHaveBeenCalled();
    expect(api.broadcast).not.toHaveBeenCalled();
  });

  it("確認文言がなければ送らない", async () => {
    const { d, api } = deps();
    expect(await core.sendBroadcast(ctx(), send({ confirmation: "はい" }), d)).toMatchObject({ fieldErrors: { confirmation: expect.any(String) } });
    expect(api.broadcast).not.toHaveBeenCalled();
  });

  it("テスト送信前・送信済みは送らない", async () => {
    const { d, api } = deps();
    vi.mocked(repo.getBroadcast).mockResolvedValueOnce(row({ status: "draft", tested_at: null }));
    expect((await core.sendBroadcast(ctx(), send(), d)).status).toBe("error");
    vi.mocked(repo.getBroadcast).mockResolvedValueOnce(row({ status: "sent" }));
    expect((await core.sendBroadcast(ctx(), send(), d)).status).toBe("error");
    expect(api.broadcast).not.toHaveBeenCalled();
  });

  it("送信可能数が足りなければ、送信権も取らずに中止する（画面の数字は使わず取り直す）", async () => {
    const { d, api, store } = deps({ quota: 200, used: 199, followers: { targetedReaches: 5 } });
    expect((await core.sendBroadcast(ctx(), send(), d)).status).toBe("error");
    expect(store.startSending).not.toHaveBeenCalled();
    expect(api.broadcast).not.toHaveBeenCalled();
  });

  it("送信権を取れなければ（連打・別の配信が送信中）送らない", async () => {
    const { d, api, store } = deps();
    store.startSending.mockRejectedValueOnce(new Error("not ready"));
    expect((await core.sendBroadcast(ctx(), send(), d)).status).toBe("error");
    expect(api.broadcast).not.toHaveBeenCalled();
  });

  it("LINE が受理済み（409）なら送信済み", async () => {
    const { d, api, store } = deps();
    api.broadcast.mockResolvedValueOnce("duplicate");
    expect((await core.sendBroadcast(ctx(), send(), d)).status).toBe("success");
    expect(store.markSent).toHaveBeenCalled();
  });

  it("4xx は失敗として記録、5xx・タイムアウトは成否不明として記録（同じ再送キーで再送できる）", async () => {
    const a = deps();
    a.api.broadcast.mockRejectedValueOnce(new LineApiError(429, "x"));
    expect((await core.sendBroadcast(ctx(), send(), a.d)).status).toBe("error");
    expect(a.store.markFailed).toHaveBeenCalledWith(ID, "broadcast_http_429");

    const b = deps();
    b.api.broadcast.mockRejectedValueOnce(new LineApiError(500, "x"));
    expect(await core.sendBroadcast(ctx(), send(), b.d)).toMatchObject({ message: expect.stringMatching(/二重に届くことはありません/) });
    expect(b.store.markFailed).toHaveBeenCalledWith(ID, core.UNKNOWN_RESULT_CODE);
  });

  it("成否不明の配信は 23 時間以内なら同じ再送キーで再送でき、過ぎたら再送させない", async () => {
    const recent = deps();
    vi.mocked(repo.getBroadcast).mockResolvedValueOnce(
      row({ status: "failed", error_message: core.UNKNOWN_RESULT_CODE, sending_started_at: new Date(NOW - 3_600_000).toISOString() }),
    );
    expect((await core.sendBroadcast(ctx(), send(), recent.d)).status).toBe("success");
    expect(recent.api.broadcast).toHaveBeenCalledWith(expect.anything(), RETRY);

    const old = deps();
    vi.mocked(repo.getBroadcast).mockResolvedValueOnce(
      row({ status: "failed", error_message: core.UNKNOWN_RESULT_CODE, sending_started_at: new Date(NOW - 24 * 3_600_000).toISOString() }),
    );
    expect(await core.sendBroadcast(ctx(), send(), old.d)).toMatchObject({ message: expect.stringMatching(/23 時間以上/) });
    expect(old.api.broadcast).not.toHaveBeenCalled();
  });
});
