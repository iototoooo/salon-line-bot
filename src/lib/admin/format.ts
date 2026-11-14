import { createHash } from "node:crypto";

/** 管理画面の表示用の整形（サーバー専用） */

const JST = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 日本時間の「2026/11/12 14:32」 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = Object.fromEntries(JST.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

/** 日本時間の日付（YYYY-MM-DD） */
export function jstDate(date: Date): string {
  const p = Object.fromEntries(JST.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * お客様の識別用ラベル。LINE ユーザー ID は画面に出さず、同じお客様だとわかる短い記号だけを表示する。
 * （オーナーは LINE 公式アカウントのチャット画面で、表示名からお客様を探して返信する）
 */
export function customerLabel(lineUserId: string): string {
  const h = createHash("sha256").update(lineUserId).digest("hex").slice(0, 6);
  return `お客様 #${h}`;
}

export function yen(n: number): string {
  return `${n.toLocaleString("ja-JP")}円`;
}
