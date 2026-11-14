import { Badge } from "./ui";

const LABELS: Record<string, { label: string; tone: "gray" | "green" | "red" | "amber" | "blue" }> = {
  draft: { label: "下書き", tone: "gray" },
  tested: { label: "テスト送信済み", tone: "blue" },
  sending: { label: "送信中", tone: "amber" },
  sent: { label: "配信済み", tone: "green" },
  failed: { label: "失敗・結果不明", tone: "red" },
};

export function BroadcastStatusBadge({ status }: { status: string }) {
  const s = LABELS[status] ?? { label: status, tone: "gray" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
