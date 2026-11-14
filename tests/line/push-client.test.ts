import { describe, expect, it, vi } from "vitest";
import { createHttpLinePushClient, LineApiError } from "@/lib/line/client";

// fetch はモック（LINE へは送信しない）
const TOKEN = "test-token-not-real";
const OWNER = `U${"e".repeat(32)}`;
const KEY = "22222222-2222-4222-8222-222222222222";
const msg = [{ type: "text" as const, text: "通知" }];

function fetchReturning(status: number, body = "") {
  return vi.fn<typeof fetch>(async () => new Response(body, { status }));
}

describe("LINE push クライアント（オーナー通知用）", () => {
  it("push API に宛先・本文と X-Line-Retry-Key を付けて送る", async () => {
    const f = fetchReturning(200, "{}");
    expect(await createHttpLinePushClient(TOKEN, f).push(OWNER, msg, KEY)).toBe("sent");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.line.me/v2/bot/message/push");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, "X-Line-Retry-Key": KEY });
    expect(JSON.parse(String(init?.body))).toEqual({ to: OWNER, messages: msg });
  });

  it("409（同じ再送キーで受理済み）は duplicate（二重には届かない）", async () => {
    expect(await createHttpLinePushClient(TOKEN, fetchReturning(409)).push(OWNER, msg, KEY)).toBe("duplicate");
  });

  it.each([400, 403, 429, 500])("%s は LineApiError（トークンをメッセージに含めない）", async (status) => {
    const err = await createHttpLinePushClient(TOKEN, fetchReturning(status, "{}")).push(OWNER, msg, KEY).catch((e) => e);
    expect(err).toBeInstanceOf(LineApiError);
    expect((err as LineApiError).status).toBe(status);
    expect(String(err.message)).not.toContain(TOKEN);
  });

  it.each([
    ["宛先がユーザー ID の形式でない", "C" + "e".repeat(32), KEY, /invalid destination/],
    ["再送キーが UUID でない", OWNER, "retry", /invalid retry key/],
  ])("%s なら送信しない", async (_l, to, key, error) => {
    const f = fetchReturning(200);
    await expect(createHttpLinePushClient(TOKEN, f).push(to, msg, key)).rejects.toThrow(error);
    expect(f).not.toHaveBeenCalled();
  });
});
