import { Suspense } from "react";
import { ConversationCard } from "@/components/admin/conversation-card";
import { EmptyState, Loading, ModeBanner, Notice, PageTitle } from "@/components/admin/ui";
import { readAdminModes } from "@/lib/admin/mode";
import { type ConversationListItem, listConversations, MAX_LIST } from "@/lib/admin/repo";
import { requireAdmin } from "@/lib/admin/session";

export default function InboxPage() {
  return (
    <>
      <PageTitle
        title="未対応一覧"
        description="AI が回答できなかった質問や、エラーで定型文を返したお問い合わせです。LINE 公式アカウントのチャットからお客様に返信したら「対応済みにする」を押してください。"
      />
      <Suspense fallback={<Loading />}>
        <Inbox />
      </Suspense>
    </>
  );
}

async function Inbox() {
  const { db } = await requireAdmin();
  const modes = readAdminModes();
  let items: ConversationListItem[];
  try {
    items = await listConversations(db, { unresolvedOnly: true });
  } catch {
    return <Notice tone="error">未対応一覧を読み込めませんでした。時間をおいて再度お試しください。</Notice>;
  }
  return (
    <div className="flex flex-col gap-4">
      <ModeBanner modes={modes} />
      <p className="text-sm">
        未対応：<span className="font-bold">{items.length}{items.length >= MAX_LIST ? " 件以上" : " 件"}</span>（新しい順）
      </p>
      {items.length === 0 ? <EmptyState>未対応のお問い合わせはありません。</EmptyState> : null}
      {items.map((c) => (
        <ConversationCard key={c.id} c={c} canResolve writeEnabled={modes.writeEnabled} />
      ))}
    </div>
  );
}
