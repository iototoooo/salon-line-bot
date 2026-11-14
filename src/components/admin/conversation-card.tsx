import { ActionForm, HiddenField } from "@/components/admin/form";
import { Badge, Card } from "@/components/admin/ui";
import { markResolvedAction } from "@/app/admin/conversation-actions";
import { customerLabel, formatDateTime } from "@/lib/admin/format";
import type { ConversationListItem } from "@/lib/admin/repo";

/** 会話ログ 1 件の表示（未対応一覧・会話ログで共通）。LINE ユーザー ID は表示せず、短い識別記号だけを出す */

const STATUS: Record<string, { label: string; tone: "gray" | "green" | "red" | "amber" | "blue" }> = {
  answered: { label: "AI が回答", tone: "green" },
  cannot_answer: { label: "回答不能（要確認）", tone: "red" },
  reservation: { label: "予約の案内", tone: "blue" },
  bot_off: { label: "自動応答 OFF 中", tone: "amber" },
  error: { label: "エラー（定型文で返信）", tone: "red" },
  unsupported: { label: "画像・スタンプなど", tone: "gray" },
};

const REPLY: Record<string, string> = { reply: "返信済み", push: "push で送信", none: "未送信（または dry-run）" };

/** 処理結果コードのうち、オーナーに意味がわかるものだけを日本語にする（それ以外は表示しない） */
const CODE_LABELS: Record<string, string> = {
  usage_shop_daily_limit: "本日の AI 利用上限に達したため定型文",
  usage_user_daily_limit: "同じお客様の 1 日の上限",
  usage_user_burst_limit: "短時間の連投",
  usage_check_failed: "利用枠を確認できなかった",
  reply_failed: "返信が LINE に拒否された",
  reply_unknown: "返信の成否が不明",
  reply_not_sent: "返信期限切れなどで未送信",
  ai_not_configured: "AI が未設定",
  ai_timeout: "AI の応答がタイムアウト",
};

export function ConversationCard({
  c,
  canResolve,
  writeEnabled,
}: {
  c: ConversationListItem;
  canResolve: boolean;
  writeEnabled: boolean;
}) {
  const s = STATUS[c.ai_status] ?? { label: c.ai_status, tone: "gray" as const };
  const notes = (c.error_message ?? "")
    .split(/\s+/)
    .map((code) => CODE_LABELS[code])
    .filter(Boolean);
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{formatDateTime(c.created_at)}</span>
        <span className="text-stone-500">{customerLabel(c.line_user_id)}</span>
        <Badge tone={s.tone}>{s.label}</Badge>
        {c.needs_owner && !c.resolved_at ? <Badge tone="red">未対応</Badge> : null}
        {c.resolved_at ? <Badge tone="green">対応済み {formatDateTime(c.resolved_at)}</Badge> : null}
        {c.owner_notified_at ? <Badge>LINE 通知済み</Badge> : null}
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <p>
          <span className="text-stone-500">お客様：</span>
          {c.message_type === "text" ? <span className="whitespace-pre-wrap">{c.user_message}</span> : `（${c.message_type}）`}
        </p>
        <p>
          <span className="text-stone-500">返信（{REPLY[c.reply_method] ?? c.reply_method}）：</span>
          <span className="whitespace-pre-wrap">{c.bot_reply ?? "—"}</span>
        </p>
        {c.ai_reason ? <p className="text-stone-600 dark:text-stone-400">AI の判断理由：{c.ai_reason}</p> : null}
        {notes.length ? <p className="text-stone-600 dark:text-stone-400">メモ：{notes.join("・")}</p> : null}
      </div>
      {canResolve && c.needs_owner && !c.resolved_at ? (
        <ActionForm action={markResolvedAction} submitLabel="対応済みにする" disabled={!writeEnabled}>
          <HiddenField name="id" value={c.id} />
        </ActionForm>
      ) : null}
    </Card>
  );
}
