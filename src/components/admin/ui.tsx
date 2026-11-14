import type { ReactNode } from "react";
import type { AdminModes } from "@/lib/admin/mode";

/** 管理画面の共通の見た目（サーバーコンポーネント） */

export function PageTitle({ title, description }: { title: string; description?: string }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-xl font-bold">{title}</h1>
      {description ? <p className="text-sm text-stone-600 dark:text-stone-400">{description}</p> : null}
    </header>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      {title ? <h2 className="font-semibold">{title}</h2> : null}
      {children}
    </section>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "error"; children: ReactNode }) {
  const cls =
    tone === "error"
      ? "bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-200"
      : tone === "warn"
        ? "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        : "bg-stone-100 text-stone-700 dark:bg-stone-800/60 dark:text-stone-300";
  return <div className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${cls}`}>{children}</div>;
}

/** 安全スイッチの状態（書き込み・LINE 送信・AI 回答テスト） */
export function ModeBanner({ modes }: { modes: AdminModes }) {
  const off = [
    !modes.writeEnabled && "保存・変更",
    !modes.lineSendEnabled && "LINE への送信",
    !modes.answerTestAiEnabled && "回答テストでの AI 呼び出し",
  ].filter(Boolean);
  if (off.length === 0) return null;
  return (
    <Notice tone="warn">
      安全のため、次の操作は無効になっています：{off.join("・")}。閲覧はできます。
    </Notice>
  );
}

export function Badge({ tone = "gray", children }: { tone?: "gray" | "green" | "red" | "amber" | "blue"; children: ReactNode }) {
  const cls = {
    gray: "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
    green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
    red: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
    amber: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200",
    blue: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200",
  }[tone];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

export function Loading({ label = "読み込み中…" }: { label?: string }) {
  return <p className="text-sm text-stone-500">{label}</p>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-stone-300 p-4 text-center text-sm text-stone-500 dark:border-stone-700">{children}</p>;
}
