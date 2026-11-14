import { describe, expect, it, vi } from "vitest";
import { createDryRunLineClient, createHttpLineClient, LineApiError } from "@/lib/line/client";
import { createLineClientFromEnv, getReplyMode } from "@/lib/line/config";

describe("createHttpLineClient（fetch はモック・実送信しない）", () => {
  it("reply API に正しい形式で送る", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    const client = createHttpLineClient("dummy-token", fetchMock);
    expect(await client.reply("rt-1", [{ type: "text", text: "こんにちは" }])).toBe("sent");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.line.me/v2/bot/message/reply");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer dummy-token");
    expect(JSON.parse(init?.body as string)).toEqual({
      replyToken: "rt-1",
      messages: [{ type: "text", text: "こんにちは" }],
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("2xx 以外は LineApiError を投げる", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{"message":"Invalid reply token"}', { status: 400 }));
    const client = createHttpLineClient("dummy-token", fetchMock);
    await expect(client.reply("rt", [{ type: "text", text: "x" }])).rejects.toBeInstanceOf(LineApiError);
  });
});

describe("返信モードの切り替え", () => {
  it("既定は dry-run", () => {
    expect(getReplyMode({} as NodeJS.ProcessEnv)).toBe("dry-run");
    expect(getReplyMode({ LINE_REPLY_MODE: "LIVE" } as unknown as NodeJS.ProcessEnv)).toBe("dry-run");
  });

  it("dry-run クライアントは送信せず、本文をログに出さない", async () => {
    const log = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await createDryRunLineClient(log).reply("rt", [{ type: "text", text: "秘密の相談" }])).toBe("simulated");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).not.toContain("秘密の相談");
    fetchSpy.mockRestore();
  });

  it("live でもトークンが空なら dry-run にフォールバックする", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createLineClientFromEnv({ LINE_REPLY_MODE: "live", LINE_CHANNEL_ACCESS_TOKEN: "" } as unknown as NodeJS.ProcessEnv);
    await client.reply("rt", [{ type: "text", text: "x" }]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    [errSpy, infoSpy, fetchSpy].forEach((s) => s.mockRestore());
  });
});
