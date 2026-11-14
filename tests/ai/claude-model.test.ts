import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnswerModelError,
  CLAUDE_CALL_LIMITS,
  classifyClaudeError,
  createClaudeAnswerModel,
  DEFAULT_CLAUDE_MODEL,
  readClaudeConfig,
} from "@/lib/ai/claude-model";

// 実在しないダミーのキー。fetch はスタブで、実際の Claude API には接続しない
const DUMMY_KEY = "test-anthropic-key-not-real";

afterEach(() => vi.unstubAllGlobals());

describe("readClaudeConfig", () => {
  it("キー未設定なら null、モデル未設定なら claude-haiku-5-5", () => {
    expect(readClaudeConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(readClaudeConfig({ ANTHROPIC_API_KEY: "  " } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(readClaudeConfig({ ANTHROPIC_API_KEY: DUMMY_KEY } as unknown as NodeJS.ProcessEnv)).toEqual({
      apiKey: DUMMY_KEY,
      model: DEFAULT_CLAUDE_MODEL,
    });
    expect(DEFAULT_CLAUDE_MODEL).toBe("claude-haiku-5-5");
    expect(
      readClaudeConfig({ ANTHROPIC_API_KEY: DUMMY_KEY, CLAUDE_MODEL: "claude-sonnet-5-5" } as unknown as NodeJS.ProcessEnv)?.model,
    ).toBe("claude-sonnet-5-5");
  });
});

describe("classifyClaudeError（SDK の型付きエラーを分類）", () => {
  const apiError = (status: number) => Anthropic.APIError.generate(status, { type: "error" }, "x", new Headers());
  it.each([
    [new Anthropic.APIConnectionTimeoutError(), "timeout"],
    [new Anthropic.APIConnectionError({ message: "x" }), "connection"],
    [apiError(429), "rate_limited"],
    [apiError(401), "auth"],
    [apiError(403), "auth"],
    [apiError(400), "bad_request"],
    [apiError(500), "server"],
    [apiError(529), "server"],
    [new Error("x"), "unknown"],
  ])("%s → %s", (err, code) => {
    expect(classifyClaudeError(err).code).toBe(code);
  });

  it("エラーメッセージに詳細（キー・本文）を含めない", () => {
    const e = new AnswerModelError("auth", 401);
    expect(e.message).toBe("claude: auth (status=401)");
  });
});

describe("createClaudeAnswerModel（fetch をスタブ）", () => {
  function stubFetch(body: unknown, status = 200) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      }),
    );
    return calls;
  }

  const message = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: '{"status":"cannot_answer"}' },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
  };

  it("構造化出力・effort・キャッシュ指定を送り、temperature は送らない。テキストだけを取り出す", async () => {
    const calls = stubFetch(message);
    const model = createClaudeAnswerModel({ apiKey: DUMMY_KEY, model: "claude-haiku-5-5" });
    const res = await model.generate({ system: "rules", knowledge: "data", user: "q", schema: { type: "object" } });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.max_tokens).toBe(CLAUDE_CALL_LIMITS.maxTokens);
    expect(body.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema: { type: "object" } } });
    expect(body.system[1]).toEqual({ type: "text", text: "data", cache_control: { type: "ephemeral" } });
    expect(body.messages).toEqual([{ role: "user", content: "q" }]);
    expect(body).not.toHaveProperty("temperature");

    expect(res).toEqual({
      text: '{"status":"cannot_answer"}',
      stopReason: "end_turn",
      model: "claude-haiku-5-5",
      inputTokens: 1000,
      outputTokens: 20,
    });
  });

  it("API エラーは再試行せず AnswerModelError に変換する", async () => {
    const calls = stubFetch({ type: "error", error: { type: "overloaded_error", message: "overloaded" } }, 529);
    const model = createClaudeAnswerModel({ apiKey: DUMMY_KEY, model: "claude-haiku-5-5" });
    const err = await model.generate({ system: "", knowledge: "", user: "q", schema: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(AnswerModelError);
    expect(err.code).toBe("server");
    expect(calls).toHaveLength(1);
    expect(String(err.message)).not.toContain(DUMMY_KEY);
  });
});
