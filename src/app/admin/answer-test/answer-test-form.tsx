"use client";

import { useActionState } from "react";
import type { AnswerTestState } from "@/lib/admin/conversation-actions";
import { answerTestAction } from "../conversation-actions";

const STATUS_LABEL: Record<string, string> = {
  answered: "AI が回答（コード側の確認に合格）",
  cannot_answer: "回答不能（「確認が必要です」の定型文＋要オーナー対応）",
  reservation: "予約の案内（登録された予約方法をそのまま返す）",
  error: "エラー・回答しない（定型文）",
};

export function AnswerTestForm() {
  const [state, action, pending] = useActionState<AnswerTestState, FormData>(answerTestAction, { status: "idle" });
  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">お客様の質問（LINE には送信されません）</span>
          <textarea
            name="question"
            rows={3}
            maxLength={1000}
            required
            defaultValue={state.status === "done" ? state.question : undefined}
            className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="w-fit rounded-lg bg-stone-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 dark:bg-stone-200 dark:text-stone-900"
        >
          {pending ? "確認中…" : "回答を確認する"}
        </button>
      </form>

      {state.status === "error" ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-200">
          {state.message}
        </p>
      ) : null}

      {state.status === "done" ? (
        <section className="flex flex-col gap-2 rounded-xl border border-stone-200 bg-white p-4 text-sm dark:border-stone-800 dark:bg-stone-900">
          {state.note ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{state.note}</p> : null}
          <p>
            <span className="text-stone-500">判定：</span>
            {STATUS_LABEL[state.result.status] ?? state.result.status}
            {state.aiCalled ? "（AI を呼び出しました）" : "（AI は呼び出していません）"}
          </p>
          <div>
            <p className="text-stone-500">お客様に返る文章：</p>
            <p className="whitespace-pre-wrap rounded-lg bg-emerald-50 p-3 dark:bg-emerald-950/40">{state.result.replyText}</p>
          </div>
          <p>
            <span className="text-stone-500">オーナー対応：</span>
            {state.result.needsOwner ? "必要（未対応一覧に載り、通知の対象）" : "不要"}
          </p>
          <p>
            <span className="text-stone-500">根拠：</span>
            FAQ {state.result.sources.faqIds.length} 件・メニュー {state.result.sources.menuIds.length} 件・店舗情報{" "}
            {state.result.sources.shopFields.length ? state.result.sources.shopFields.join("、") : "なし"}
          </p>
          {state.result.reason ? <p><span className="text-stone-500">AI の判断理由：</span>{state.result.reason}</p> : null}
          {state.result.code ? <p className="text-xs text-stone-500">処理結果コード：{state.result.code}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
