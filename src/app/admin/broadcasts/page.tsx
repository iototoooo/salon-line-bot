import Link from "next/link";
import { Suspense } from "react";
import { ActionForm, TextArea } from "@/components/admin/form";
import { BroadcastStatusBadge } from "@/components/admin/broadcast-status";
import { Card, EmptyState, Loading, ModeBanner, Notice, PageTitle } from "@/components/admin/ui";
import { formatDateTime } from "@/lib/admin/format";
import { readAdminModes, WRITE_DISABLED_MESSAGE } from "@/lib/admin/mode";
import { listBroadcasts } from "@/lib/admin/repo";
import { requireAdmin } from "@/lib/admin/session";
import { LIMITS } from "@/lib/admin/validation";
import type { BroadcastRow } from "@/types/database";
import { createDraftAction } from "../broadcast-actions";

export default function BroadcastsPage() {
  return (
    <>
      <PageTitle
        title="お知らせ配信"
        description="臨時休業などのお知らせを、LINE の友だち全員に配信します。下書き → テスト送信 → 送信数の確認 → 確認文言の入力 → 配信の順に進みます。"
      />
      <Suspense fallback={<Loading />}>
        <Broadcasts />
      </Suspense>
    </>
  );
}

async function Broadcasts() {
  const { db } = await requireAdmin();
  const modes = readAdminModes();
  let items: BroadcastRow[];
  try {
    items = await listBroadcasts(db);
  } catch {
    return <Notice tone="error">配信の履歴を読み込めませんでした。時間をおいて再度お試しください。</Notice>;
  }
  return (
    <div className="flex flex-col gap-4">
      <ModeBanner modes={modes} />
      <Notice tone="warn">
        一斉配信は友だちの人数分の送信数を使います（無料プランは月 200 通まで）。配信前に必ず送信可能数を確認します。
      </Notice>
      <Card title="新しいお知らせ（下書き）">
        <ActionForm action={createDraftAction} submitLabel="下書きを保存" disabled={!modes.writeEnabled} disabledReason={WRITE_DISABLED_MESSAGE}>
          <TextArea name="body" label="本文" maxLength={LIMITS.broadcastBody} rows={6} required hint={`${LIMITS.broadcastBody.toLocaleString("ja-JP")} 文字まで。`} />
        </ActionForm>
      </Card>

      <h2 className="font-semibold">配信の履歴（新しい順・最大 50 件）</h2>
      {items.length === 0 ? <EmptyState>まだ配信はありません。</EmptyState> : null}
      <ul className="flex flex-col gap-2">
        {items.map((b) => (
          <li key={b.id}>
            <Link
              href={`/admin/broadcasts/${b.id}`}
              className="flex flex-col gap-1 rounded-xl border border-stone-200 bg-white p-3 hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-900 dark:hover:bg-stone-800"
            >
              <span className="flex flex-wrap items-center gap-2 text-sm">
                <BroadcastStatusBadge status={b.status} />
                <span className="text-stone-500">作成 {formatDateTime(b.created_at)}</span>
                {b.sent_at ? <span className="text-stone-500">配信 {formatDateTime(b.sent_at)}</span> : null}
                {b.estimated_recipients !== null ? <span className="text-stone-500">対象 {b.estimated_recipients} 人</span> : null}
              </span>
              <span className="line-clamp-2 whitespace-pre-wrap text-sm">{b.body}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
