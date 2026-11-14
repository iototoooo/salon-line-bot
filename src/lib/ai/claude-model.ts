import Anthropic from "@anthropic-ai/sdk";

/**
 * Claude API の呼び出し（サーバー専用。クライアントコンポーネントから import しないこと）。
 *
 * - API キーは環境変数 ANTHROPIC_API_KEY からのみ読む。値をログ・エラーメッセージに出さない
 * - 応答生成は AnswerModel インターフェース越しに行い、テストではモックに差し替える（実 API は呼ばない）
 * - 費用・時間の上限：max_tokens、effort、タイムアウト、再試行なし（LINE の返信期限 50 秒以内に収める）
 *
 * モデル・パラメータの根拠（2026-11-11 に公式ドキュメントで確認）
 *   - claude-haiku-5-5 は Claude API の現行 Haiku。構造化出力（output_config.format）と effort に対応
 *   - Haiku 5.5 は temperature 等の既定外の値を受け付けないため送らない（回答のぶれは出力の検証で抑える）
 *   - thinking は adaptive が既定で、出力トークン（max_tokens）に含まれる。effort=low で抑える
 */

export const DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";

export const CLAUDE_CALL_LIMITS = {
  /** thinking を含む出力の上限。回答は 200 文字程度の JSON なので十分 */
  maxTokens: 1024,
  /** Claude API 呼び出しのタイムアウト（設計書 5.3：15 秒程度） */
  timeoutMs: 15_000,
  /** 再試行しない（タイムアウト × 回数で返信期限を超えないように） */
  maxRetries: 0,
  effort: "low" as const,
};

export type ModelRequest = {
  /** 固定のルール */
  system: string;
  /** 登録情報（プロンプトキャッシュの対象） */
  knowledge: string;
  /** お客様のメッセージ */
  user: string;
  /** 構造化出力の JSON スキーマ */
  schema: Record<string, unknown>;
};

export type ModelResponse = {
  /** テキストブロックを連結したもの（JSON 文字列のはず）。なければ null */
  text: string | null;
  stopReason: string | null;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

export interface AnswerModel {
  readonly model: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export type AnswerModelErrorCode =
  | "timeout"
  | "rate_limited"
  | "auth"
  | "bad_request"
  | "server"
  | "connection"
  | "unknown";

/** Claude API 呼び出しの失敗。メッセージには分類コードと HTTP ステータスだけを含める */
export class AnswerModelError extends Error {
  constructor(
    readonly code: AnswerModelErrorCode,
    readonly status?: number,
  ) {
    super(`claude: ${code}${status ? ` (status=${status})` : ""}`);
    this.name = "AnswerModelError";
  }
}

export type ClaudeConfig = { apiKey: string; model: string };

/** ANTHROPIC_API_KEY が未設定なら null（AI 応答はエラー扱いの定型文になる） */
export function readClaudeConfig(env: NodeJS.ProcessEnv = process.env): ClaudeConfig | null {
  const apiKey = (env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const model = (env.CLAUDE_MODEL ?? "").trim() || DEFAULT_CLAUDE_MODEL;
  return { apiKey, model };
}

export function classifyClaudeError(err: unknown): AnswerModelError {
  if (err instanceof AnswerModelError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AnswerModelError("timeout");
  if (err instanceof Anthropic.APIConnectionError) return new AnswerModelError("connection");
  if (err instanceof Anthropic.RateLimitError) return new AnswerModelError("rate_limited", 429);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AnswerModelError("auth", err.status);
  }
  if (err instanceof Anthropic.BadRequestError) return new AnswerModelError("bad_request", 400);
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : undefined;
    return new AnswerModelError(status !== undefined && status >= 500 ? "server" : "unknown", status);
  }
  return new AnswerModelError("unknown");
}

/** 公式 SDK による実装。テストでは使わない */
export function createClaudeAnswerModel(config: ClaudeConfig): AnswerModel {
  const client = new Anthropic({
    apiKey: config.apiKey,
    timeout: CLAUDE_CALL_LIMITS.timeoutMs,
    maxRetries: CLAUDE_CALL_LIMITS.maxRetries,
  });
  return {
    model: config.model,
    async generate(request) {
      let res: Anthropic.Message;
      try {
        res = await client.messages.create({
          model: config.model,
          max_tokens: CLAUDE_CALL_LIMITS.maxTokens,
          system: [
            { type: "text", text: request.system },
            // 登録情報は質問ごとに変わらないため、キャッシュの対象にする（短い場合は API 側でキャッシュされない）
            { type: "text", text: request.knowledge, cache_control: { type: "ephemeral" } },
          ],
          messages: [{ role: "user", content: request.user }],
          output_config: {
            effort: CLAUDE_CALL_LIMITS.effort,
            format: { type: "json_schema", schema: request.schema },
          },
        });
      } catch (err) {
        throw classifyClaudeError(err);
      }
      const texts = res.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
      return {
        text: texts.length > 0 ? texts.join("") : null,
        stopReason: res.stop_reason ?? null,
        model: res.model,
        inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
        outputTokens: res.usage.output_tokens,
      };
    },
  };
}
