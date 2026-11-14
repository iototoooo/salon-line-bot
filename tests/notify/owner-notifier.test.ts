import { describe, expect, it, vi } from "vitest";
import { LineApiError, type LinePushClient } from "@/lib/line/client";
import type { NotificationSource } from "@/lib/notify/owner-message";
import {
  type ClaimResult,
  classifyPushError,
  createOwnerNotifier,
  OWNER_NOTIFICATION_LIMITS,
  type OwnerNotificationStore,
  type OwnerNotifierDeps,
} from "@/lib/notify/owner-notifier";
import { silentLogger } from "../line/fixtures";

// LINE・Supabase はすべてモック（実際の送信・DB 接続はしない）

const OWNER = `U${"e".repeat(32)}`;
const CUSTOMER = `U${"f".repeat(32)}`;
const BATCH = "11111111-1111-4111-8111-111111111111";
const RETRY_KEY = "22222222-2222-4222-8222-222222222222";

const claimed = (over: Partial<Extract<ClaimResult, { batchId: string }>> = {}): ClaimResult => ({
  result: "claimed",
  batchId: BATCH,
  retryKey: RETRY_KEY,
  eventIds: ["ev2", "ev1"],
  pendingCount: 2,
  urgent: false,
  attempt: 1,
  ...over,
});

const sources: NotificationSource[] = [
  {
    eventId: "ev1",
    receivedAt: "2026-11-12T05:00:00Z",
    conversation: { aiStatus: "unsupported", errorMessage: null, userMessage: null },
    event: { status: "done", lastError: null },
  },
  {
    eventId: "ev2",
    receivedAt: "2026-11-12T05:30:00Z",
    conversation: { aiStatus: "cannot_answer", errorMessage: null, userMessage: `シャンプーはありますか 090-1234-5678 ${CUSTOMER}` },
    event: { status: "done", lastError: null },
  },
];

function setup(over: Partial<OwnerNotifierDeps> = {}, claim: ClaimResult = claimed()) {
  const store = {
    claim: vi.fn<OwnerNotificationStore["claim"]>(async () => claim),
    finish: vi.fn<OwnerNotificationStore["finish"]>(async () => true),
    loadSources: vi.fn<OwnerNotificationStore["loadSources"]>(async () => sources),
  };
  const push = { push: vi.fn<LinePushClient["push"]>(async () => "sent") };
  const logger = silentLogger();
  const deps: OwnerNotifierDeps = {
    mode: "live",
    store,
    push,
    loadOwnerId: vi.fn(async () => OWNER),
    appBaseUrl: "https://salon.example.com",
    logger,
    ...over,
  };
  return { notifier: createOwnerNotifier(deps), store, push, logger, deps };
}

const allLogs = (logger: ReturnType<typeof silentLogger>) =>
  JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]);

describe("オーナー通知（flush）", () => {
  it("確保したまとめを、オーナーにだけ 1 通で push し、送信済みを記録する", async () => {
    const { notifier, store, push } = setup();
    expect(await notifier.flush()).toBe("sent");

    expect(store.claim).toHaveBeenCalledWith({ urgent: false, limits: OWNER_NOTIFICATION_LIMITS });
    expect(push.push).toHaveBeenCalledTimes(1);
    const [to, messages, retryKey] = push.push.mock.calls[0];
    expect(to).toBe(OWNER);
    expect(retryKey).toBe(RETRY_KEY);
    expect(messages).toHaveLength(1);
    // 新しい順（eventIds の順）に並べる
    const lines = messages[0].text.split("\n");
    expect(lines[0]).toBe("【要対応】LINE のお問い合わせ 2 件");
    expect(lines[1]).toMatch(/^・11\/12 14:30 確認が必要な質問「シャンプーはありますか/);
    expect(lines[2]).toBe("・11/12 14:00 画像・スタンプなど");
    expect(store.finish).toHaveBeenCalledWith(BATCH, "sent", undefined);
  });

  it("通知文にお客様の LINE ユーザー ID・電話番号を含めない", async () => {
    const { notifier, push } = setup();
    await notifier.flush();
    const text = push.push.mock.calls[0][1][0].text;
    expect(text).not.toContain(CUSTOMER);
    expect(text).not.toContain("1234");
  });

  it("ログにオーナー・お客様の ID、質問の本文、通知文を出さない", async () => {
    const { notifier, logger } = setup();
    await notifier.flush();
    const logs = allLogs(logger);
    expect(logs).not.toContain(OWNER);
    expect(logs).not.toContain(CUSTOMER);
    expect(logs).not.toContain("シャンプー");
  });

  it("urgent（店舗全体の AI 利用上限）を DB の確保に渡す", async () => {
    const { notifier, store, push } = setup({}, claimed({ urgent: true }));
    await notifier.flush({ urgent: true });
    expect(store.claim).toHaveBeenCalledWith(expect.objectContaining({ urgent: true }));
    expect(push.push.mock.calls[0][1][0].text.split("\n")[0]).toContain("利用上限に達しました");
  });

  it("dry-run では DB にも LINE にも何もしない", async () => {
    const { notifier, store, push, deps } = setup({ mode: "dry-run" });
    expect(await notifier.flush()).toBe("dry_run");
    expect(deps.loadOwnerId).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(push.push).not.toHaveBeenCalled();
  });

  it("push クライアントがなければ dry-run と同じ扱い", async () => {
    const { notifier, store } = setup({ push: null });
    expect(await notifier.flush()).toBe("dry_run");
    expect(store.claim).not.toHaveBeenCalled();
  });

  it.each([
    ["未設定", null],
    ["形式不正", "owner"],
    ["大文字を含む", `U${"E".repeat(32)}`],
  ])("通知先が%sなら確保も送信もしない（対象は未通知のまま残る）", async (_l, owner) => {
    const { notifier, store, push, logger } = setup({ loadOwnerId: vi.fn(async () => owner) });
    expect(await notifier.flush()).toBe("no_recipient");
    expect(store.claim).not.toHaveBeenCalled();
    expect(push.push).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("owner_line_user_id is not set"));
  });

  it("通知先を読めない（DB エラー）なら送らず error", async () => {
    const { notifier, store } = setup({ loadOwnerId: vi.fn(async () => Promise.reject(new Error("db down"))) });
    expect(await notifier.flush()).toBe("error");
    expect(store.claim).not.toHaveBeenCalled();
  });

  it.each(["nothing", "throttled", "daily_limit", "busy"] as const)("確保の結果が %s なら送らない", async (result) => {
    const { notifier, push, store } = setup({}, { result });
    expect(await notifier.flush()).toBe(result);
    expect(push.push).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
  });

  it("確保に失敗したら送らない（例外を外に出さない）", async () => {
    const { notifier, push, store } = setup();
    store.claim.mockRejectedValueOnce(new Error("db"));
    expect(await notifier.flush()).toBe("error");
    expect(push.push).not.toHaveBeenCalled();
  });

  it("成否不明のまとめの再送（retry）は、同じ再送キーで送る", async () => {
    const { notifier, push } = setup({}, claimed({ result: "retry", attempt: 2 }));
    expect(await notifier.flush()).toBe("sent");
    expect(push.push.mock.calls[0][2]).toBe(RETRY_KEY);
  });

  it("LINE が受理済み（409）なら送信済みとして記録する", async () => {
    const { notifier, push, store } = setup();
    push.push.mockResolvedValueOnce("duplicate");
    expect(await notifier.flush()).toBe("sent");
    expect(store.finish).toHaveBeenCalledWith(BATCH, "sent", undefined);
  });

  it.each([
    ["4xx（ブロック・宛先不正など）", new LineApiError(400, "bad"), "failed", "push_http_400"],
    ["429（送信数の上限など）", new LineApiError(429, "too many"), "failed", "push_http_429"],
    ["5xx", new LineApiError(500, "error"), "unknown", "push_http_500"],
    ["タイムアウト", Object.assign(new Error("timeout"), { name: "TimeoutError" }), "unknown", "push_timeout"],
    ["通信エラー", new TypeError("fetch failed"), "unknown", "push_network_error"],
  ])("push の失敗：%s → %s", async (_l, err, result, code) => {
    const { notifier, push, store } = setup();
    push.push.mockRejectedValueOnce(err);
    expect(await notifier.flush()).toBe(result);
    expect(store.finish).toHaveBeenCalledWith(BATCH, result, code);
  });

  it("詳細を読めなくても、件数とリンクだけで送る", async () => {
    const { notifier, push, store } = setup();
    store.loadSources.mockRejectedValueOnce(new Error("db"));
    expect(await notifier.flush()).toBe("sent");
    const text = push.push.mock.calls[0][1][0].text;
    expect(text).toContain("【要対応】LINE のお問い合わせ 2 件");
    expect(text).toContain("https://salon.example.com/admin/inbox");
  });

  it("結果を記録できなくても例外を外に出さない（送信中のまとめは後で同じキーで再送される）", async () => {
    const { notifier, store, logger } = setup();
    store.finish.mockRejectedValueOnce(new Error("db"));
    expect(await notifier.flush()).toBe("sent");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("failed to record result=sent"), expect.any(String));
  });

  it("詳細は先頭 5 件だけ読む", async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `ev${i}`);
    const { notifier, store } = setup({}, claimed({ eventIds: ids, pendingCount: 9 }));
    await notifier.flush();
    expect(store.loadSources).toHaveBeenCalledWith(ids.slice(0, 5));
  });
});

describe("push の失敗の分類", () => {
  it("送信前に拒否した形式エラーは failed", () => {
    expect(classifyPushError(new Error("push: invalid destination"))).toEqual(["failed", "push_invalid_request"]);
  });
  it("不明な例外は unknown（同じキーで再送）", () => {
    expect(classifyPushError("x")).toEqual(["unknown", "push_network_error"]);
  });
});
