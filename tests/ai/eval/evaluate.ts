import type { AnswerResult } from "@/lib/ai/answer";
import { extractYenAmounts, hasAvailabilityClaim } from "@/lib/ai/guard";
import type { EvalCase } from "./questions";

/**
 * 1 問ごとの評価（AC-12）。AI の出力ではなく、コード側の検証を通った「最終的にお客様へ送る返信」を評価する。
 *
 *   appropriate    : 回答が適切（状態が期待どおり、かつ以下すべてを満たす）
 *   matchesSource  : 登録情報と一致（含めるべき文言・根拠の記録）
 *   noAvailability : 予約可否・空き状況を断定していない
 *   noWrongPrice   : 登録外の金額を含まない
 *   ownerRouting   : オーナー対応の要否が期待どおり
 */
export type EvalResult = {
  id: string;
  appropriate: boolean;
  matchesSource: boolean;
  noAvailability: boolean;
  noWrongPrice: boolean;
  ownerRouting: boolean;
  problems: string[];
};

export function evaluate(c: EvalCase, r: AnswerResult): EvalResult {
  const problems: string[] = [];
  const reply = r.replyText;

  const statusOk = c.expect.status.includes(r.status);
  if (!statusOk) problems.push(`status=${r.status}（期待：${c.expect.status.join(" / ")}）`);

  let matchesSource = true;
  for (const s of c.expect.mustInclude ?? []) {
    if (!reply.includes(s)) {
      matchesSource = false;
      problems.push(`「${s}」を含まない`);
    }
  }
  for (const s of c.expect.mustNotInclude ?? []) {
    if (reply.includes(s)) {
      matchesSource = false;
      problems.push(`「${s}」を含む`);
    }
  }
  const src = c.expect.sources;
  if (src && statusOk && r.status !== "cannot_answer") {
    const missing = [
      ...(src.faqIds ?? []).filter((x) => !r.sources.faqIds.includes(x)),
      ...(src.menuIds ?? []).filter((x) => !r.sources.menuIds.includes(x)),
      ...(src.shopFields ?? []).filter((x) => !r.sources.shopFields.includes(x)),
    ];
    if (missing.length > 0) {
      matchesSource = false;
      problems.push(`根拠の記録が不足：${missing.join(", ")}`);
    }
  }

  const noAvailability = !hasAvailabilityClaim(reply);
  if (!noAvailability) problems.push("予約可否・空き状況を断定している");

  const allowed = new Set(c.expect.allowedAmounts ?? []);
  const wrong = extractYenAmounts(reply).filter((a) => !allowed.has(a));
  const noWrongPrice = wrong.length === 0;
  if (!noWrongPrice) problems.push(`登録外の金額：${wrong.join(", ")}`);

  const ownerRouting = r.needsOwner === c.expect.needsOwner;
  if (!ownerRouting) problems.push(`needsOwner=${r.needsOwner}（期待：${c.expect.needsOwner}）`);

  return {
    id: c.id,
    appropriate: statusOk && matchesSource && noAvailability && noWrongPrice && ownerRouting,
    matchesSource,
    noAvailability,
    noWrongPrice,
    ownerRouting,
    problems,
  };
}

/** AC-12 の合格判定：18 問以上が適切、かつ料金の誤り・予約可否の断定が 0 件 */
export function summarize(results: EvalResult[]) {
  const appropriate = results.filter((r) => r.appropriate).length;
  const wrongPrice = results.filter((r) => !r.noWrongPrice).length;
  const availability = results.filter((r) => !r.noAvailability).length;
  return {
    total: results.length,
    appropriate,
    wrongPrice,
    availability,
    passed: results.length >= 20 && appropriate >= 18 && wrongPrice === 0 && availability === 0,
  };
}
