import { describe, expect, it } from "vitest";
import {
  classify,
  excerptOf,
  formatJst,
  inboxUrl,
  MAX_LISTED_ITEMS,
  type NotificationItem,
  type NotificationSource,
  renderOwnerNotification,
  toItem,
} from "@/lib/notify/owner-message";

const USER = `U${"a".repeat(32)}`;

function source(over: Partial<NotificationSource> = {}): NotificationSource {
  return {
    eventId: "ev1",
    receivedAt: "2026-11-12T05:32:00Z", // 日本時間 11/12 14:32
    conversation: { aiStatus: "cannot_answer", errorMessage: null, userMessage: "〇〇のシャンプーは売っていますか？" },
    event: { status: "done", lastError: null },
    ...over,
  };
}

const conv = (aiStatus: string, errorMessage: string | null = null) => ({ aiStatus, errorMessage, userMessage: "質問" });

describe("通知の分類", () => {
  it.each([
    ["回答不能", source(), "cannot_answer"],
    ["予約の変更・キャンセル", source({ conversation: conv("reservation") }), "reservation_change"],
    ["画像・スタンプ", source({ conversation: conv("unsupported") }), "unsupported"],
    ["自動応答 OFF", source({ conversation: conv("bot_off") }), "bot_off"],
    ["AI 処理エラー", source({ conversation: conv("error", "ai_timeout") }), "ai_error"],
    ["店舗全体の AI 利用上限", source({ conversation: conv("error", "usage_shop_daily_limit") }), "usage_shop_limit"],
    ["利用枠の確認エラー", source({ conversation: conv("error", "usage_check_failed") }), "usage_check_failed"],
    ["回答は正常だが返信に失敗", source({ conversation: conv("answered", "reply_failed") }), "reply_failed"],
    ["会話ログなし・処理の停止", source({ conversation: null, event: { status: "abandoned", lastError: "stalled: processing did not finish" } }), "stalled"],
    ["会話ログなし・返信失敗", source({ conversation: null, event: { status: "failed", lastError: "reply_unknown" } }), "reply_failed"],
    ["会話ログなし・その他", source({ conversation: null, event: { status: "failed", lastError: "responder_failed" } }), "system_error"],
    ["記録なし", source({ conversation: null, event: null }), "system_error"],
  ])("%s", (_l, s, expected) => {
    expect(classify(s)).toBe(expected);
  });
});

describe("質問の先頭部分（要約）", () => {
  it("20 文字で切り、改行・空白をまとめる", () => {
    expect(excerptOf("一二三四五六七八九十\n一二三四五六七八九十一二三")).toBe("一二三四五六七八九十 一二三四五六七八九…");
  });

  it("電話番号・メールアドレス・LINE ユーザー ID を伏せる", () => {
    const e = excerptOf(`090-1234-5678 a@b.jp ${USER}`)!;
    expect(e).not.toMatch(/1234|a@b\.jp|Uaaaa/);
    expect(e).toContain("[電話番号省略]");
  });

  it.each([
    ["https://evil.example/login", "x"],
    ["http://a.co", "x"],
    ["www.evil.example", "x"],
    ["evil.example/path", "x"],
    ["ＬＩＮＥ.ｊｐ", "x"],
  ])("URL・ドメイン名（%s）はリンクにならないよう伏せる", (url) => {
    const e = excerptOf(`確認 ${url}`)!;
    expect(e).toContain("[URL省略]");
    expect(e).not.toMatch(/evil|a\.co|line\.jp/i);
  });

  it("空・空白だけなら null", () => {
    expect(excerptOf(null)).toBeNull();
    expect(excerptOf("  \n ")).toBeNull();
  });

  it("サロゲートペア（絵文字など）を途中で切らない", () => {
    const e = excerptOf("😀".repeat(25))!;
    expect(Array.from(e)).toHaveLength(21);
    expect(e.endsWith("…")).toBe(true);
  });

  it("テキスト以外・システムエラーには本文を載せない", () => {
    expect(toItem(source({ conversation: { aiStatus: "unsupported", errorMessage: null, userMessage: "x" } })).excerpt).toBeNull();
    expect(toItem(source({ conversation: null, event: { status: "abandoned", lastError: null } })).excerpt).toBeNull();
    expect(toItem(source()).excerpt).toBe("〇〇のシャンプーは売っていますか？");
  });
});

describe("日時・リンク", () => {
  it("日本時間で表示する", () => {
    expect(formatJst("2026-11-12T05:32:00Z")).toBe("11/12 14:32");
    expect(formatJst("2026-11-12T15:05:00Z")).toBe("11/13 00:05");
    expect(formatJst("invalid")).toBe("日時不明");
  });

  it.each([
    ["https://salon.example.com", "https://salon.example.com/admin/inbox"],
    ["https://salon.example.com/some/path?x=1", "https://salon.example.com/admin/inbox"],
    ["http://localhost:3000", "http://localhost:3000/admin/inbox"],
    ["http://salon.example.com", null],
    ["https://user:pass@salon.example.com", null],
    ["javascript:alert(1)", null],
    ["not a url", null],
    [null, null],
  ])("%s → %s", (base, expected) => {
    expect(inboxUrl(base)).toBe(expected);
  });
});

describe("通知文", () => {
  const item = (over: Partial<NotificationItem> = {}): NotificationItem => ({
    eventId: "ev",
    receivedAt: "2026-11-12T05:32:00Z",
    category: "cannot_answer",
    excerpt: "シャンプーは売っていますか",
    ...over,
  });

  it("件数・受信日時・理由・質問の先頭部分・未対応一覧のリンクを含む", () => {
    const text = renderOwnerNotification({ items: [item()], total: 1, urgent: false, appBaseUrl: "https://salon.example.com" });
    expect(text).toBe(
      [
        "【要対応】LINE のお問い合わせ 1 件",
        "・11/12 14:32 確認が必要な質問「シャンプーは売っていますか」",
        "未対応一覧：https://salon.example.com/admin/inbox",
      ].join("\n"),
    );
  });

  it(`詳細は ${MAX_LISTED_ITEMS} 件まで。残りは「ほか N 件」`, () => {
    const items = Array.from({ length: 7 }, () => item());
    const text = renderOwnerNotification({ items, total: 12, urgent: false, appBaseUrl: null });
    expect(text.split("\n").filter((l) => l.startsWith("・"))).toHaveLength(MAX_LISTED_ITEMS);
    expect(text).toContain("【要対応】LINE のお問い合わせ 12 件");
    expect(text).toContain("ほか 7 件");
    expect(text).toContain("管理画面の未対応一覧でご確認ください。");
  });

  it("詳細を読めなかった場合も件数だけで送れる", () => {
    const text = renderOwnerNotification({ items: [], total: 3, urgent: false, appBaseUrl: null });
    expect(text).toContain("【要対応】LINE のお問い合わせ 3 件");
    expect(text).toContain("ほか 3 件");
  });

  it("店舗全体の AI 利用上限に達したときは先頭に明記する", () => {
    const urgent = renderOwnerNotification({ items: [], total: 1, urgent: true, appBaseUrl: null });
    expect(urgent.split("\n")[0]).toContain("利用上限に達しました");
    const byItem = renderOwnerNotification({ items: [item({ category: "usage_shop_limit" })], total: 1, urgent: false, appBaseUrl: null });
    expect(byItem.split("\n")[0]).toContain("利用上限に達しました");
  });

  it("LINE ユーザー ID を含めない（質問文に含まれていても伏せる）", () => {
    const it1 = toItem(source({ conversation: { aiStatus: "cannot_answer", errorMessage: null, userMessage: `${USER} です` } }));
    const text = renderOwnerNotification({ items: [it1], total: 1, urgent: false, appBaseUrl: null });
    expect(text).not.toContain(USER);
  });

  it("LINE の上限より十分短い", () => {
    const items = Array.from({ length: 5 }, () => item({ excerpt: "あ".repeat(20) }));
    expect(renderOwnerNotification({ items, total: 200, urgent: true, appBaseUrl: "https://salon.example.com" }).length).toBeLessThan(2000);
  });
});
