import Link from "next/link";
import { Suspense } from "react";
import { Badge, Card, Loading, ModeBanner, Notice, PageTitle } from "@/components/admin/ui";
import { readAdminModes } from "@/lib/admin/mode";
import { getDashboardSummary } from "@/lib/admin/repo";
import { requireAdmin } from "@/lib/admin/session";

export default function AdminHome() {
  return (
    <>
      <PageTitle title="ホーム" description="お問い合わせの状況と、自動応答の設定を確認できます。" />
      <Suspense fallback={<Loading />}>
        <Summary />
      </Suspense>
    </>
  );
}

async function Summary() {
  const { db } = await requireAdmin();
  const modes = readAdminModes();
  let s;
  try {
    s = await getDashboardSummary(db);
  } catch {
    return <Notice tone="error">情報を読み込めませんでした。時間をおいて再度お試しください。</Notice>;
  }
  return (
    <div className="flex flex-col gap-4">
      <ModeBanner modes={modes} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="未対応のお問い合わせ">
          <p className="text-3xl font-bold">{s.unresolved} 件</p>
          <Link href="/admin/inbox" className="text-sm underline">
            未対応一覧を開く
          </Link>
        </Card>
        <Card title="自動応答">
          <p>{s.shop.bot_enabled ? <Badge tone="green">ON（AI が回答）</Badge> : <Badge tone="amber">OFF（定型文のみ）</Badge>}</p>
          <p className="text-sm text-stone-600 dark:text-stone-400">
            通知先：{s.shop.ownerSet ? <Badge tone="green">設定済み</Badge> : <Badge tone="red">未設定</Badge>}
          </p>
          <Link href="/admin/settings" className="text-sm underline">
            店舗情報・設定を開く
          </Link>
        </Card>
        <Card title="FAQ">
          <p className="text-sm">
            登録 {s.faqs} 件（公開中 {s.publishedFaqs} 件）
          </p>
          <Link href="/admin/faqs" className="text-sm underline">
            FAQ を編集する
          </Link>
        </Card>
        <Card title="メニュー・料金">
          <p className="text-sm">登録 {s.menus} 件</p>
          <Link href="/admin/menus" className="text-sm underline">
            メニューを編集する
          </Link>
        </Card>
      </div>
      {s.faqs === 0 || s.menus === 0 ? (
        <Notice tone="warn">FAQ またはメニューが未登録です。AI は登録された情報だけを根拠に回答するため、先に登録してください。</Notice>
      ) : null}
    </div>
  );
}
