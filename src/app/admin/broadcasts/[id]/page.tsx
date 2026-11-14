import Link from "next/link";
import { Suspense } from "react";
import { BroadcastStatusBadge } from "@/components/admin/broadcast-status";
import { ActionForm, CheckboxField, HiddenField, TextArea, TextField } from "@/components/admin/form";
import { Card, Loading, ModeBanner, Notice, PageTitle } from "@/components/admin/ui";
import { loadSendPreview, type SendPreview } from "@/lib/admin/broadcast-actions";
import { formatDateTime } from "@/lib/admin/format";
import { LINE_SEND_DISABLED_MESSAGE, readAdminModes, WRITE_DISABLED_MESSAGE } from "@/lib/admin/mode";
import { getBroadcast } from "@/lib/admin/repo";
import { requireAdmin } from "@/lib/admin/session";
import { BROADCAST_CONFIRMATION, LIMITS, UUID } from "@/lib/admin/validation";
import { createLineBroadcastApi } from "@/lib/line/broadcast-client";
import type { BroadcastRow } from "@/types/database";
import { deleteDraftAction, sendBroadcastAction, sendTestAction, updateDraftAction } from "../../broadcast-actions";

export default function BroadcastDetailPage({ params }: PageProps<"/admin/broadcasts/[id]">) {
  return (
    <>
      <PageTitle title="お知らせ配信の確認" />
      <Link href="/admin/broadcasts" className="w-fit text-sm underline">
        配信の一覧に戻る
      </Link>
      <Suspense fallback={<Loading />}>
        <Detail params={params} />
      </Suspense>
    </>
  );
}

async function Detail({ params }: { params: PageProps<"/admin/broadcasts/[id]">["params"] }) {
  const { db } = await requireAdmin();
  const modes = readAdminModes();
  const { id } = await params;
  if (!UUID.test(id)) return <Notice tone="error">配信が見つかりませんでした。</Notice>;

  let b: BroadcastRow | null;
  try {
    b = await getBroadcast(db, id);
  } catch {
    return <Notice tone="error">配信を読み込めませんでした。時間をおいて再度お試しください。</Notice>;
  }
  if (!b) return <Notice tone="error">配信が見つかりませんでした。</Notice>;

  const editable = b.status === "draft" || b.status === "tested" || b.status === "failed";
  const testable = b.status === "draft" || b.status === "tested";
  const sendable = (b.status === "tested" || b.status === "failed") && b.tested_at !== null;
  const writeOff = !modes.writeEnabled;
  const sendOff = writeOff || !modes.lineSendEnabled;

  return (
    <div className="flex flex-col gap-4">
      <ModeBanner modes={modes} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <BroadcastStatusBadge status={b.status} />
          <span className="text-stone-500">作成 {formatDateTime(b.created_at)}</span>
          {b.tested_at ? <span className="text-stone-500">テスト送信 {formatDateTime(b.tested_at)}</span> : null}
          {b.sent_at ? <span className="text-stone-500">配信 {formatDateTime(b.sent_at)}</span> : null}
        </div>
        {b.status === "failed" ? (
          <Notice tone="error">
            前回の配信は失敗、または結果が確認できませんでした。LINE 公式アカウントの管理画面で配信されたかを確認してから操作してください。
          </Notice>
        ) : null}
        {b.status === "sending" ? (
          <Notice tone="warn">送信中です。しばらくしても変わらない場合は、LINE 公式アカウントの管理画面で配信履歴を確認してください。</Notice>
        ) : null}
      </Card>

      <Card title="プレビュー（LINE での見え方の目安）">
        <div className="rounded-2xl bg-[#8cabd9] p-4">
          <p className="w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tl-sm bg-white px-4 py-2 text-sm text-stone-900 shadow-sm">
            {b.body}
          </p>
        </div>
        <p className="text-xs text-stone-500">{Array.from(b.body).length.toLocaleString("ja-JP")} 文字</p>
      </Card>

      {editable ? (
        <Card title="本文の編集">
          <ActionForm action={updateDraftAction} submitLabel="本文を保存" disabled={writeOff} disabledReason={WRITE_DISABLED_MESSAGE}>
            <HiddenField name="id" value={b.id} />
            <TextArea name="body" label="本文" defaultValue={b.body} maxLength={LIMITS.broadcastBody} rows={6} required
              hint="本文を変えると、テスト送信からやり直しになります。" />
          </ActionForm>
        </Card>
      ) : null}

      {testable ? (
        <Card title="1. テスト送信（オーナーの LINE にだけ届きます）">
          <ActionForm action={sendTestAction} submitLabel="オーナーにテスト送信" disabled={sendOff}
            disabledReason={writeOff ? WRITE_DISABLED_MESSAGE : LINE_SEND_DISABLED_MESSAGE}>
            <HiddenField name="id" value={b.id} />
          </ActionForm>
        </Card>
      ) : null}

      {sendable ? (
        <Card title="2. 配信（友だち全員に送ります）">
          <Suspense fallback={<Loading label="送信可能数を確認中…" />}>
            <SendSection id={b.id} lineSendEnabled={modes.lineSendEnabled} disabled={sendOff} />
          </Suspense>
        </Card>
      ) : b.status === "draft" ? (
        <Notice>配信するには、先にテスト送信をして内容を確認してください。</Notice>
      ) : null}

      {b.status === "draft" || b.status === "tested" ? (
        <Card title="削除">
          <ActionForm action={deleteDraftAction} submitLabel="削除" danger disabled={writeOff}>
            <HiddenField name="id" value={b.id} />
            <CheckboxField name="confirm_delete" label="削除する（元に戻せません）" />
          </ActionForm>
        </Card>
      ) : null}
    </div>
  );
}

/** LINE への送信が無効のときは、LINE の API（送信数の確認）にも接続しない */
async function fetchPreview(lineSendEnabled: boolean): Promise<SendPreview | null> {
  const token = (process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "").trim();
  if (!lineSendEnabled || !token) return null;
  return loadSendPreview(createLineBroadcastApi(token), Date.now());
}

async function SendSection({ id, lineSendEnabled, disabled }: { id: string; lineSendEnabled: boolean; disabled: boolean }) {
  const preview = await fetchPreview(lineSendEnabled);

  return (
    <div className="flex flex-col gap-3">
      {preview === null ? (
        <Notice>{LINE_SEND_DISABLED_MESSAGE}（送信可能数も確認していません）</Notice>
      ) : !preview.ok ? (
        <Notice tone="error">{preview.reason}</Notice>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-stone-500">配信対象（目安・前日時点）</dt>
          <dd className="font-semibold">{preview.recipients.toLocaleString("ja-JP")} 人</dd>
          <dt className="text-stone-500">今月の残り送信可能数</dt>
          <dd className="font-semibold">{preview.remaining === null ? "上限なし" : `${preview.remaining.toLocaleString("ja-JP")} 通`}</dd>
          <dt className="text-stone-500">配信後の残り見込み</dt>
          <dd className="font-semibold">{preview.after === null ? "上限なし" : `${preview.after.toLocaleString("ja-JP")} 通`}</dd>
        </dl>
      )}
      {preview && preview.ok && !preview.enough ? (
        <Notice tone="error">送信可能数が足りないため配信できません（追加料金の発生を防ぐため）。</Notice>
      ) : null}
      <ActionForm
        action={sendBroadcastAction}
        submitLabel="友だち全員に配信する"
        danger
        disabled={disabled || !preview || !preview.ok || !preview.enough}
        disabledReason={disabled ? "送信は無効になっています。" : "送信可能数を確認できないか、足りません。"}
      >
        <HiddenField name="id" value={id} />
        <TextField name="confirmation" label={`確認のため「${BROADCAST_CONFIRMATION}」と入力`} autoComplete="off" />
      </ActionForm>
    </div>
  );
}
