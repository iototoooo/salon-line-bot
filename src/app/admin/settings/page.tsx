import { Suspense } from "react";
import { ActionForm, CheckboxField, HiddenField, TextArea, TextField } from "@/components/admin/form";
import { Badge, Card, Loading, ModeBanner, Notice, PageTitle } from "@/components/admin/ui";
import { readAdminModes, WRITE_DISABLED_MESSAGE } from "@/lib/admin/mode";
import { getShop } from "@/lib/admin/repo";
import { requireAdmin } from "@/lib/admin/session";
import { BOT_TOGGLE_CONFIRMATION, LIMITS } from "@/lib/admin/validation";
import type { ShopSettingsRow } from "@/types/database";
import { changeBotEnabledAction, saveOwnerLineUserIdAction, saveShopInfoAction } from "../actions";

export default function SettingsPage() {
  return (
    <>
      <PageTitle title="店舗情報・設定" description="AI の回答の根拠になる店舗情報と、自動応答・通知の設定です。" />
      <Suspense fallback={<Loading />}>
        <Settings />
      </Suspense>
    </>
  );
}

async function Settings() {
  const { db } = await requireAdmin();
  const modes = readAdminModes();
  const disabled = !modes.writeEnabled;
  let shop: ShopSettingsRow;
  try {
    shop = await getShop(db);
  } catch {
    return <Notice tone="error">店舗情報を読み込めませんでした。時間をおいて再度お試しください。</Notice>;
  }
  return (
    <div className="flex flex-col gap-4">
      <ModeBanner modes={modes} />

      <Card title="自動応答（緊急停止スイッチ）">
        <p className="text-sm">
          現在：{shop.bot_enabled ? <Badge tone="green">ON（AI が回答）</Badge> : <Badge tone="amber">OFF（定型文のみ）</Badge>}
        </p>
        <Notice>
          OFF にすると AI を使わず、下の「定型文」だけを返します。誤った回答が続く場合などに使います。
          {shop.bot_enabled ? null : " ON にする前に、FAQ・メニュー・店舗情報が正しく登録されているか確認してください。"}
        </Notice>
        <ActionForm
          action={changeBotEnabledAction}
          submitLabel={shop.bot_enabled ? "自動応答を OFF にする" : "自動応答を ON にする"}
          danger={!shop.bot_enabled}
          disabled={disabled}
          disabledReason={WRITE_DISABLED_MESSAGE}
        >
          <HiddenField name="bot_enabled" value={String(!shop.bot_enabled)} />
          <TextField name="confirmation" label={`確認のため「${BOT_TOGGLE_CONFIRMATION}」と入力`} autoComplete="off" />
        </ActionForm>
      </Card>

      <Card title="オーナー通知の送り先（LINE）">
        <p className="text-sm">
          現在：{shop.owner_line_user_id ? <Badge tone="green">設定済み</Badge> : <Badge tone="red">未設定（通知は送られません）</Badge>}
        </p>
        <Notice>
          LINE Developers コンソールのチャネル「基本設定」にある「あなたのユーザーID」（U で始まる 33 文字）を入力します。
          通知を受け取るには、オーナーの LINE で公式アカウントを友だち追加しておく必要があります。安全のため、登録済みの値は表示しません。
        </Notice>
        <ActionForm action={saveOwnerLineUserIdAction} submitLabel="保存する" disabled={disabled} disabledReason={WRITE_DISABLED_MESSAGE} resetOnSuccess>
          <TextField name="owner_line_user_id" label="LINE ユーザー ID" autoComplete="off" maxLength={33} placeholder="U から始まる 33 文字" />
          <CheckboxField name="clear" label="通知先を解除する" />
        </ActionForm>
      </Card>

      <Card title="店舗情報">
        <ActionForm action={saveShopInfoAction} submitLabel="保存する" disabled={disabled} disabledReason={WRITE_DISABLED_MESSAGE}>
          <TextField name="shop_name" label="店名" defaultValue={shop.shop_name} maxLength={LIMITS.shopName} />
          <TextArea name="business_hours" label="営業時間" defaultValue={shop.business_hours} maxLength={LIMITS.businessHours} rows={2} />
          <TextArea name="regular_holidays" label="定休日" defaultValue={shop.regular_holidays} maxLength={LIMITS.regularHolidays} rows={2} />
          <TextField name="address" label="住所" defaultValue={shop.address} maxLength={LIMITS.address} />
          <TextField name="phone" label="電話番号" defaultValue={shop.phone} maxLength={LIMITS.phone} />
          <TextArea name="parking" label="駐車場" defaultValue={shop.parking} maxLength={LIMITS.parking} rows={2} />
          <TextArea name="reservation_guide" label="予約方法の案内" defaultValue={shop.reservation_guide} maxLength={LIMITS.reservationGuide} rows={3}
            hint="空き状況・予約の可否を聞かれたとき、AI の文章ではなくこの文章をそのまま返します（電話番号・予約ページの URL など）。" />
          <TextArea name="temporary_notice" label="臨時のお知らせ" defaultValue={shop.temporary_notice} maxLength={LIMITS.temporaryNotice} rows={2}
            hint="臨時休業など。AI の回答の根拠にも使われます。不要になったら空欄にしてください。" />
          <TextArea name="fallback_message" label="定型文（自動応答 OFF・エラー時）" defaultValue={shop.fallback_message} maxLength={LIMITS.fallbackMessage} rows={2} required />
        </ActionForm>
      </Card>
    </div>
  );
}
