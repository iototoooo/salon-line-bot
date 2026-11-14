import { Suspense } from "react";
import { ConversationCard } from "@/components/admin/conversation-card";
import { EmptyState, Loading, ModeBanner, Notice, PageTitle } from "@/components/admin/ui";
import { readAdminModes } from "@/lib/admin/mode";
import { type ConversationListItem, jstDayRange, listConversations, MAX_LIST } from "@/lib/admin/repo";
import { requireAdmin } from "@/lib/admin/session";

export default function ConversationsPage({ searchParams }: PageProps<"/admin/conversations">) {
  return (
    <>
      <PageTitle title="会話ログ" description="お客様とのやり取りの記録です（保存期間 90 日）。日付と未対応で絞り込めます。" />
      <Suspense fallback={<Loading />}>
        <Conversations searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Conversations({ searchParams }: { searchParams: PageProps<"/admin/conversations">["searchParams"] }) {
  const { db } = await requireAdmin();
  const modes = readAdminModes();
  const params = await searchParams;
  const rawDate = typeof params.date === "string" ? params.date : "";
  const date = rawDate && jstDayRange(rawDate) ? rawDate : "";
  const unresolvedOnly = params.status === "unresolved";

  let items: ConversationListItem[];
  try {
    items = await listConversations(db, { date: date || undefined, unresolvedOnly });
  } catch {
    return <Notice tone="error">会話ログを読み込めませんでした。時間をおいて再度お試しください。</Notice>;
  }
  return (
    <div className="flex flex-col gap-4">
      <ModeBanner modes={modes} />
      {/* 検索条件は URL に入れる（GET）。データの変更はしない */}
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-stone-200 bg-white p-4 text-sm dark:border-stone-800 dark:bg-stone-900">
        <label className="flex flex-col gap-1">
          <span className="font-medium">日付（日本時間）</span>
          <input type="date" name="date" defaultValue={date} className="rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-900" />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="status" value="unresolved" defaultChecked={unresolvedOnly} className="h-4 w-4" />
          未対応のみ
        </label>
        <button type="submit" className="rounded-lg bg-stone-800 px-4 py-2 font-semibold text-white dark:bg-stone-200 dark:text-stone-900">
          絞り込む
        </button>
        {rawDate && !date ? <span className="text-red-700">日付の形式が正しくないため、すべての日付を表示しています。</span> : null}
      </form>
      <p className="text-sm">
        {items.length}
        {items.length >= MAX_LIST ? " 件（最新の " + MAX_LIST + " 件まで表示）" : " 件"}
      </p>
      {items.length === 0 ? <EmptyState>該当する会話はありません。</EmptyState> : null}
      {items.map((c) => (
        <ConversationCard key={c.id} c={c} canResolve writeEnabled={modes.writeEnabled} />
      ))}
    </div>
  );
}
