import { Suspense } from "react";
import { ActionForm, CheckboxField, HiddenField, SelectField, TextArea, TextField } from "@/components/admin/form";
import { Badge, Card, EmptyState, Loading, ModeBanner, Notice, PageTitle } from "@/components/admin/ui";
import { yen } from "@/lib/admin/format";
import { readAdminModes, WRITE_DISABLED_MESSAGE } from "@/lib/admin/mode";
import { listMenus } from "@/lib/admin/repo";
import { requireAdmin } from "@/lib/admin/session";
import { LIMITS, MENU_CATEGORIES } from "@/lib/admin/validation";
import type { MenuRow } from "@/types/database";
import { removeMenuAction, saveMenuAction, toggleMenuPublishedAction } from "../actions";

export default function MenusPage() {
  return (
    <>
      <PageTitle
        title="メニュー・料金"
        description="料金は税込・円・整数で登録します。AI は登録された金額だけを案内し、計算（合計・割引）はしません。変更は次のお問い合わせから反映されます。"
      />
      <Suspense fallback={<Loading />}>
        <MenuList />
      </Suspense>
    </>
  );
}

const categoryLabel = (v: string) => MENU_CATEGORIES.find((c) => c.value === v)?.label ?? v;

function MenuFields({ menu }: { menu?: MenuRow }) {
  return (
    <>
      {menu ? <HiddenField name="id" value={menu.id} /> : null}
      <TextField name="name" label="メニュー名" defaultValue={menu?.name} maxLength={LIMITS.menuName} required hint="例：カット、カット＋カラー" />
      <SelectField name="category" label="分類" options={MENU_CATEGORIES} defaultValue={menu?.category ?? "cut"} />
      <TextField name="price" label="料金（税込・円）" defaultValue={menu?.price} required
        hint={`0〜${LIMITS.menuPriceMax.toLocaleString("ja-JP")} 円。カンマ・全角数字も入力できます。`} />
      <TextField name="price_note" label="料金の補足" defaultValue={menu?.price_note} maxLength={LIMITS.menuPriceNote}
        hint="例：ロング +1,100円。ここに書いた金額も AI の案内に使われます。" />
      <TextField name="duration_min" label="所要時間（分）" defaultValue={menu?.duration_min} hint={`空欄可。1〜${LIMITS.menuDurationMax} 分。`} />
      <TextArea name="description" label="説明" defaultValue={menu?.description} maxLength={LIMITS.menuDescription} rows={2} />
      <TextField name="sort_order" label="表示順" type="number" defaultValue={menu?.sort_order ?? 0} />
      <CheckboxField name="is_published" label="公開する（AI の回答に使う）" defaultChecked={menu?.is_published ?? true} />
    </>
  );
}

async function MenuList() {
  const { db } = await requireAdmin();
  const modes = readAdminModes();
  const disabled = !modes.writeEnabled;
  let menus: MenuRow[];
  try {
    menus = await listMenus(db);
  } catch {
    return <Notice tone="error">メニューを読み込めませんでした。時間をおいて再度お試しください。</Notice>;
  }
  return (
    <div className="flex flex-col gap-4">
      <ModeBanner modes={modes} />
      <Card title="メニューを追加">
        <ActionForm action={saveMenuAction} submitLabel="追加する" disabled={disabled} disabledReason={WRITE_DISABLED_MESSAGE} resetOnSuccess>
          <MenuFields />
        </ActionForm>
      </Card>

      <h2 className="font-semibold">登録済み（{menus.length} 件）</h2>
      {menus.length === 0 ? <EmptyState>まだメニューが登録されていません。</EmptyState> : null}
      {menus.map((m) => (
        <Card key={m.id}>
          <div className="flex flex-wrap items-center gap-2">
            {m.is_published ? <Badge tone="green">公開中</Badge> : <Badge>非公開</Badge>}
            <Badge tone="blue">{categoryLabel(m.category)}</Badge>
            <span className="text-xs text-stone-500">表示順 {m.sort_order}</span>
          </div>
          <p className="font-medium">
            {m.name}　<span className="font-bold">{yen(m.price)}</span>
            {m.price_note ? <span className="text-sm text-stone-600 dark:text-stone-400">（{m.price_note}）</span> : null}
          </p>
          {m.duration_min ? <p className="text-sm text-stone-600 dark:text-stone-400">所要時間の目安：{m.duration_min} 分</p> : null}
          {m.description ? <p className="whitespace-pre-wrap text-sm">{m.description}</p> : null}
          <details className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
            <summary className="cursor-pointer text-sm font-medium">編集・公開切り替え・削除</summary>
            <div className="mt-3 flex flex-col gap-4">
              <ActionForm action={saveMenuAction} submitLabel="保存する" disabled={disabled} disabledReason={WRITE_DISABLED_MESSAGE}>
                <MenuFields menu={m} />
              </ActionForm>
              <ActionForm action={toggleMenuPublishedAction} submitLabel={m.is_published ? "非公開にする" : "公開する"} disabled={disabled}>
                <HiddenField name="id" value={m.id} />
                <HiddenField name="published" value={String(!m.is_published)} />
              </ActionForm>
              <ActionForm action={removeMenuAction} submitLabel="削除" danger disabled={disabled}>
                <HiddenField name="id" value={m.id} />
                <CheckboxField name="confirm_delete" label="削除する（元に戻せません）" />
              </ActionForm>
            </div>
          </details>
        </Card>
      ))}
    </div>
  );
}
