import { describe, expect, it } from "vitest";
import { generateAnswer } from "@/lib/ai/answer";
import { evaluate, summarize } from "./eval/evaluate";
import { EVAL_CASES } from "./eval/questions";
import { fakeModel, knowledge } from "./fixtures";

/**
 * 想定質問 20 問（AC-12）をモックの AI で評価する。実際の Claude API は呼ばない。
 *   good：期待どおりの AI 出力 → 20 問すべて「適切」
 *   bad ：誤った AI 出力（料金の誤り・予約可否の断定・推測）→ コード側の検証で、料金の誤り・断定が 0 件になる
 */
async function runCase(c: (typeof EVAL_CASES)[number], output: Record<string, unknown>) {
  const { model } = fakeModel(output);
  const result = await generateAnswer({
    question: c.question,
    knowledge: knowledge(),
    model,
    errorMessage: "担当者から折り返しご連絡いたします。",
    reserveUsage: async () => "reserved",
    now: () => 0,
  });
  return evaluate(c, result);
}

describe("想定質問 20 問の評価セット", () => {
  it("20 問あり、教材の頻出 5 問（AC-01〜05）と回答不能（AC-06）を含む", () => {
    expect(EVAL_CASES).toHaveLength(20);
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(20);
    expect(EVAL_CASES.map((c) => c.ac).filter(Boolean)).toEqual(["AC-01", "AC-02", "AC-03", "AC-04", "AC-05", "AC-06"]);
  });

  describe("期待どおりの AI 出力（good）", () => {
    it.each(EVAL_CASES.map((c) => [c.id, c.topic, c] as const))("%s %s", async (_id, _topic, c) => {
      const r = await runCase(c, c.good);
      expect(r.problems).toEqual([]);
      expect(r.appropriate).toBe(true);
    });

    it("AC-12：20 問中 20 問が適切、料金の誤り・予約可否の断定は 0 件", async () => {
      const s = summarize(await Promise.all(EVAL_CASES.map((c) => runCase(c, c.good))));
      expect(s).toEqual({ total: 20, appropriate: 20, wrongPrice: 0, availability: 0, passed: true });
    });
  });

  describe("誤った AI 出力（bad）でも、お客様に誤りが届かない", () => {
    it.each(EVAL_CASES.map((c) => [c.id, c.topic, c] as const))("%s %s", async (_id, _topic, c) => {
      const r = await runCase(c, c.bad);
      expect(r.noWrongPrice).toBe(true);
      expect(r.noAvailability).toBe(true);
    });

    it("料金の誤り・予約可否の断定は 0 件（誤りは定型文・予約案内に置き換わる）", async () => {
      const s = summarize(await Promise.all(EVAL_CASES.map((c) => runCase(c, c.bad))));
      expect(s.wrongPrice).toBe(0);
      expect(s.availability).toBe(0);
    });
  });

  it("評価関数は、誤った返信（登録外の金額・断定・オーナー対応漏れ）を検出できる", () => {
    const c = EVAL_CASES[1]; // Q02 カット料金
    const r = evaluate(c, {
      status: "answered",
      replyText: "カットは 3,850円です。明日もご予約いただけます。",
      needsOwner: true,
      category: "price",
      sources: { faqIds: [], menuIds: [], shopFields: [] },
      reason: null,
      code: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
    });
    expect(r).toMatchObject({ appropriate: false, matchesSource: false, noAvailability: false, noWrongPrice: false, ownerRouting: false });
  });
});
