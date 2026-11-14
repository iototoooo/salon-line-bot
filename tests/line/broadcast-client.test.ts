import { describe, expect, it, vi } from "vitest";
import { createLineBroadcastApi } from "@/lib/line/broadcast-client";
import { LineApiError } from "@/lib/line/client";

// fetch はモック（LINE には接続しない）
const TOKEN = "test-token-not-real";
const KEY = "22222222-2222-4222-8222-222222222222";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("一斉配信用の LINE API クライアント", () => {
  it("今月の上限・送信数・友だち数を読む（GET のみ・トークンは Authorization ヘッダー）", async () => {
    const f = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.endsWith("/v2/bot/message/quota")) return json({ type: "limited", value: 200 });
      if (u.endsWith("/v2/bot/message/quota/consumption")) return json({ totalUsage: 12 });
      return json({ status: "ready", followers: 30, targetedReaches: 28, blocks: 2 });
    });
    const api = createLineBroadcastApi(TOKEN, f);
    expect(await api.getQuota()).toEqual({ type: "limited", value: 200 });
    expect(await api.getConsumption()).toBe(12);
    expect(await api.getFollowers("20261112")).toEqual({ status: "ready", followers: 30, targetedReaches: 28, blocks: 2 });
    for (const [, init] of f.mock.calls) {
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    }
    expect(String(f.mock.calls[2][0])).toBe("https://api.line.me/v2/bot/insight/followers?date=20261112");
  });

  it("上限なしのプラン（type: none）", async () => {
    expect(await createLineBroadcastApi(TOKEN, vi.fn(async () => json({ type: "none" }))).getQuota()).toEqual({ type: "none" });
  });

  it("想定外の応答・エラーは例外", async () => {
    await expect(createLineBroadcastApi(TOKEN, vi.fn(async () => json({ type: "limited" }))).getQuota()).rejects.toThrow();
    await expect(createLineBroadcastApi(TOKEN, vi.fn(async () => json({}, 401))).getConsumption()).rejects.toBeInstanceOf(LineApiError);
    await expect(createLineBroadcastApi(TOKEN, vi.fn()).getFollowers("2026-11-12")).rejects.toThrow(/invalid date/);
  });

  it("配信は X-Line-Retry-Key 付きで POST。409（受理済み）は duplicate", async () => {
    const f = vi.fn<typeof fetch>(async () => json({}, 200));
    const api = createLineBroadcastApi(TOKEN, f);
    expect(await api.broadcast([{ type: "text", text: "お知らせ" }], KEY)).toBe("sent");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.line.me/v2/bot/message/broadcast");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "X-Line-Retry-Key": KEY });
    expect(JSON.parse(String(init?.body))).toEqual({ messages: [{ type: "text", text: "お知らせ" }] });

    expect(await createLineBroadcastApi(TOKEN, vi.fn(async () => json({}, 409))).broadcast([{ type: "text", text: "x" }], KEY)).toBe("duplicate");
  });

  it("再送キーが不正・メッセージ数が不正なら送信しない", async () => {
    const f = vi.fn<typeof fetch>();
    const api = createLineBroadcastApi(TOKEN, f);
    await expect(api.broadcast([{ type: "text", text: "x" }], "retry")).rejects.toThrow(/retry key/);
    await expect(api.broadcast([], KEY)).rejects.toThrow(/message count/);
    expect(f).not.toHaveBeenCalled();
  });
});
