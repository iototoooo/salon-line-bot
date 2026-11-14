import { describe, expect, it, vi } from "vitest";
import { InMemoryWebhookEventStore } from "@/lib/line/event-store";
import { type CronDeps, handleOwnerNotifyCron, isAuthorized } from "@/lib/notify/cron";
import type { OwnerNotifier } from "@/lib/notify/owner-notifier";
import { silentLogger } from "../line/fixtures";

const SECRET = "x".repeat(40);
const req = (auth?: string) =>
  new Request("http://localhost/api/cron/owner-notify", { headers: auth ? { authorization: auth } : {} });

function deps(over: Partial<CronDeps> = {}) {
  const notifier: OwnerNotifier = { flush: vi.fn(async () => "nothing" as const) };
  const store = new InMemoryWebhookEventStore();
  const getDeps = vi.fn(() => ({ store, notifier, logger: silentLogger(), ...over }));
  return { getDeps, notifier, store };
}

describe("定期実行（/api/cron/owner-notify）", () => {
  it("正しい Bearer で、停止イベントの検出と通知のまとめ送信を行う（件数と結果コードだけを返す）", async () => {
    const { getDeps, notifier } = deps();
    const res = await handleOwnerNotifyCron(req(`Bearer ${SECRET}`), SECRET, getDeps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stalled: 0, notification: "nothing" });
    expect(notifier.flush).toHaveBeenCalledWith({ urgent: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["ヘッダーなし", undefined],
    ["違う値", "Bearer wrong"],
    ["Bearer なし", SECRET],
    ["末尾に余分な文字", `Bearer ${SECRET}x`],
    ["秘密の値の一部だけ", `Bearer ${SECRET.slice(0, 20)}`],
  ])("認証に失敗（%s）したら 401。設定の読み込みも処理もしない", async (_l, auth) => {
    const { getDeps, notifier } = deps();
    const res = await handleOwnerNotifyCron(req(auth), SECRET, getDeps);
    expect(res.status).toBe(401);
    expect(getDeps).not.toHaveBeenCalled();
    expect(notifier.flush).not.toHaveBeenCalled();
  });

  it.each([
    ["未設定", undefined],
    ["空", ""],
    ["短すぎる", "short-secret"],
  ])("CRON_SECRET が%sなら常に 503（無効）", async (_l, secret) => {
    const { getDeps } = deps();
    const res = await handleOwnerNotifyCron(req(`Bearer ${secret ?? ""}`), secret, getDeps);
    expect(res.status).toBe(503);
    expect(getDeps).not.toHaveBeenCalled();
  });

  it("通知が無効（memory ストアなど）でも 200（notification=disabled）", async () => {
    const { getDeps } = deps({ notifier: null, store: null });
    const res = await handleOwnerNotifyCron(req(`Bearer ${SECRET}`), SECRET, getDeps);
    expect(await res.json()).toEqual({ ok: true, stalled: null, notification: "disabled" });
  });

  it("停止イベントの検出に失敗しても通知は行う。実行履歴で気づけるよう 500 を返す", async () => {
    const store = new InMemoryWebhookEventStore();
    vi.spyOn(store, "markStalled").mockRejectedValueOnce(new Error("db"));
    const { getDeps, notifier } = deps({ store });
    const res = await handleOwnerNotifyCron(req(`Bearer ${SECRET}`), SECRET, getDeps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, stalled: null, notification: "nothing", error: "stalled_check_failed" });
    expect(notifier.flush).toHaveBeenCalled();
  });

  it.each(["error", "failed", "unknown"] as const)(
    "通知の結果が %s なら 500（Vercel は再試行しない。次回の実行で同じ再送キーで送り直す）",
    async (outcome) => {
      const notifier: OwnerNotifier = { flush: vi.fn(async () => outcome) };
      const { getDeps } = deps({ notifier });
      const res = await handleOwnerNotifyCron(req(`Bearer ${SECRET}`), SECRET, getDeps);
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ ok: false, notification: outcome });
    },
  );

  it.each(["sent", "nothing", "throttled", "daily_limit", "busy", "dry_run", "no_recipient"] as const)(
    "通知の結果が %s なら 200（正常な状態）",
    async (outcome) => {
      const notifier: OwnerNotifier = { flush: vi.fn(async () => outcome) };
      const { getDeps } = deps({ notifier });
      expect((await handleOwnerNotifyCron(req(`Bearer ${SECRET}`), SECRET, getDeps)).status).toBe(200);
    },
  );

  it("同じ実行が重複して届いても（Schedules は重複・遅延時のまとめ実行がありうる）、通知の確保は毎回 DB に任せる", async () => {
    // DB 側（claim_owner_notification_batch）がロックと間隔で 1 通にまとめる。ここでは 2 回とも flush を呼ぶだけ
    const flush = vi.fn<OwnerNotifier["flush"]>().mockResolvedValueOnce("sent").mockResolvedValueOnce("throttled");
    const { getDeps } = deps({ notifier: { flush } });
    const r1 = await handleOwnerNotifyCron(req(`Bearer ${SECRET}`), SECRET, getDeps);
    const r2 = await handleOwnerNotifyCron(req(`Bearer ${SECRET}`), SECRET, getDeps);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("設定エラーは 500（詳細は返さない）", async () => {
    const res = await handleOwnerNotifyCron(req(`Bearer ${SECRET}`), SECRET, () => {
      throw new Error("SUPABASE_URL is wrong: https://secret.example");
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret.example");
  });

  it("比較は完全一致のみ", () => {
    expect(isAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isAuthorized(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(isAuthorized(null, SECRET)).toBe(false);
  });
});
