import { Suspense } from "react";
import { ActionForm, CheckboxField, HiddenField, SelectField, TextArea, TextField } from "@/components/admin/form";
import { Badge, Card, EmptyState, Loading, ModeBanner, Notice, PageTitle } from "@/components/admin/ui";
import { readAdminModes, WRITE_DISABLED_MESSAGE } from "@/lib/admin/mode";
import { listFaqs } from "@/lib/admin/repo";
import { requireAdmin } from "@/lib/admin/session";
import { FAQ_CATEGORIES, LIMITS } from "@/lib/admin/validation";
import type { FaqRow } from "@/types/database";
import { removeFaqAction, saveFaqAction, toggleFaqPublishedAction } from "../actions";

export default function FaqsPage() {
  return (
    <>
      <PageTitle
        title="FAQ（よくある質問）"
        description="公開中の FAQ だけが AI の回答の根拠になります。回答はお客様にそのまま伝わる文章で書いてください。"
      />
      <Suspense fallback={<Loading />}>
        <FaqList />
      </Suspense>
    </>
  );
}

const categoryLabel = (v: string) => FAQ_CATEGORIES.find((c) => c.value === v)?.label ?? v;

function FaqFields({ faq }: { faq?: FaqRow }) {
  return (
    <>
      {faq ? <HiddenField name="id" value={faq.id} /> : null}
      <TextField name="question" label="質問" defaultValue={faq?.question} maxLength={LIMITS.faqQuestion} required
        hint={`${LIMITS.faqQuestion} 文字まで。例：パーマとカラーは同時にできますか？`} />
      <TextArea name="answer" label="回答" defaultValue={faq?.answer} maxLength={LIMITS.faqAnswer} required rows={4}
        hint={`${LIMITS.faqAnswer} 文字まで。料金は「メニュー・料金」に登録し、ここには書かないことをおすすめします。`} />
      <SelectField name="category" label="分類" options={FAQ_CATEGORIES} defaultValue={faq?.category ?? "other"} />
      <TextField name="sort_order" label="表示順" type="number" defaultValue={faq?.sort_order ?? 0} hint="小さい順に並びます。" />
      <CheckboxField name="is_published" label="公開する（AI の回答に使う）" defaultChecked={faq?.is_published ?? true} />
    </>
  );
}

async function FaqList() {
  const { db } = await requireAdmin();
  const modes = readAdminModes();
  const disabled = !modes.writeEnabled;
  let faqs: FaqRow[];
  try {
    faqs = await listFaqs(db);
  } catch {
    return <Notice tone="error">FAQ を読み込めませんでした。時間をおいて再度お試しください。</Notice>;
  }
  return (
    <div className="flex flex-col gap-4">
      <ModeBanner modes={modes} />
      <Card title="FAQ を追加">
        <ActionForm action={saveFaqAction} submitLabel="追加する" disabled={disabled} disabledReason={WRITE_DISABLED_MESSAGE} resetOnSuccess>
          <FaqFields />
        </ActionForm>
      </Card>

      <h2 className="font-semibold">登録済み（{faqs.length} 件）</h2>
      {faqs.length === 0 ? <EmptyState>まだ FAQ が登録されていません。</EmptyState> : null}
      {faqs.map((f) => (
        <Card key={f.id}>
          <div className="flex flex-wrap items-center gap-2">
            {f.is_published ? <Badge tone="green">公開中</Badge> : <Badge>非公開</Badge>}
            <Badge tone="blue">{categoryLabel(f.category)}</Badge>
            <span className="text-xs text-stone-500">表示順 {f.sort_order}</span>
          </div>
          <p className="font-medium">Q. {f.question}</p>
          <p className="whitespace-pre-wrap text-sm text-stone-700 dark:text-stone-300">A. {f.answer}</p>
          <details className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
            <summary className="cursor-pointer text-sm font-medium">編集・公開切り替え・削除</summary>
            <div className="mt-3 flex flex-col gap-4">
              <ActionForm action={saveFaqAction} submitLabel="保存する" disabled={disabled} disabledReason={WRITE_DISABLED_MESSAGE}>
                <FaqFields faq={f} />
              </ActionForm>
              <ActionForm action={toggleFaqPublishedAction} submitLabel={f.is_published ? "非公開にする" : "公開する"} disabled={disabled}>
                <HiddenField name="id" value={f.id} />
                <HiddenField name="published" value={String(!f.is_published)} />
              </ActionForm>
              <ActionForm action={removeFaqAction} submitLabel="削除" danger disabled={disabled}>
                <HiddenField name="id" value={f.id} />
                <CheckboxField name="confirm_delete" label="削除する（元に戻せません）" />
              </ActionForm>
            </div>
          </details>
        </Card>
      ))}
    </div>
  );
}
