import { describe, expect, it } from "vitest";
import {
  asksAvailability,
  extractPhoneNumbers,
  extractUrls,
  extractYenAmounts,
  hasAmbiguousAmount,
  hasAvailabilityClaim,
  maskPersonalInfo,
} from "@/lib/ai/guard";
import { buildKnowledge, formatYen, isKnowledgeEmpty, KNOWLEDGE_LIMITS } from "@/lib/ai/knowledge";
import { AI_OUTPUT_SCHEMA, parseAiOutput } from "@/lib/ai/output";
import { escapeData, renderKnowledge, SYSTEM_RULES } from "@/lib/ai/prompt";
import { emptyShopRow, FAQS, MENUS, shopRow } from "./fixtures";

describe("金額・電話番号・URL の抽出", () => {
  it.each([
    ["カットは4,400円です", [4400]],
    ["カットは ¥4400、カラーは￥6,600", [4400, 6600]],
    ["４，４００円", [4400]],
    ["1万円", [10000]],
    ["1.2万円", [12000]],
    ["1万5千円", [15000]],
    ["1万5000円", [15000]],
    ["5千円", [5000]],
    ["所要時間は60分、駐車場は2台", []],
  ])("%s → %j", (text, expected) => {
    expect(extractYenAmounts(text).sort((a, b) => a - b)).toEqual(expected);
  });

  it("電話番号は数字だけに正規化し、+81 は 0 にする", () => {
    expect(extractPhoneNumbers("お電話は 03-1234-5678 または +81 90-1111-2222")).toEqual(["0312345678", "09011112222"]);
    expect(extractPhoneNumbers("０３（１２３４）５６７８")).toEqual(["0312345678"]);
  });

  it("URL の末尾の句読点は除く。スキームなしのドメインも拾う（メールアドレスは除く）", () => {
    expect(extractUrls("詳しくは https://example.com/a。")).toEqual(["https://example.com/a"]);
    expect(extractUrls("www.Example.com/x または evil.example.jp")).toEqual(["www.example.com/x", "evil.example.jp"]);
    expect(extractUrls("info@example.com まで")).toEqual([]);
  });

  it("長音記号・全角ダッシュ区切りの電話番号も拾う", () => {
    expect(extractPhoneNumbers("090ー1234ー5678 / ０３－１２３４－５６７８")).toEqual(["09012345678", "0312345678"]);
  });

  it.each([
    ["カットは4400です", true],
    ["3,000〜5,000円", true],
    ["5千5百円", true],
    ["4400えん", true],
    ["カットは4,400円、所要時間は60分、10:00〜19:00、駐車場は2台、〒100-0001", false],
    ["お電話は 00-0000-0000 まで", false],
  ])("照合できない金額表記の判定：%s → %s", (text, expected) => {
    expect(hasAmbiguousAmount(text)).toBe(expected);
  });

  it("判定理由の電話番号・メールアドレス・LINE ID を伏せる", () => {
    expect(maskPersonalInfo(`山田です。090-1234-5678 / a.b@example.com / U${"0".repeat(32)}`)).toBe(
      "山田です。[電話番号省略] / [メール省略] / [ID省略]",
    );
  });
});

describe("予約の判定", () => {
  it.each([
    "明日14時は空いています",
    "その時間は空いていません",
    "空きがございます",
    "あいにく満席です",
    "ご予約いただけます",
    "ご予約を承りました",
    "予約を確定しました",
    "お席をお取りしました",
    "明日の14時にお待ちしております",
    "明日10時は大丈夫です",
    "土曜日もご案内可能です",
    "お席をご用意できます",
    "空席がございます",
  ])("断定表現：%s", (text) => {
    expect(hasAvailabilityClaim(text)).toBe(true);
  });

  it.each(["営業時間は10:00〜19:00です", "ご予約はお電話で承っております。", "定休日は毎週火曜日です", "カードは利用可能です"])("断定ではない：%s", (text) => {
    // 「承っております」は予約方法の案内の言い回し
    expect(hasAvailabilityClaim(text)).toBe(false);
  });

  it.each(["キャンセル料はいくら？", "キャンセルポリシーを教えて", "予約方法を教えて", "日曜は何時まで営業？"])(
    "予約の規定・営業時間の質問は空き状況の質問として扱わない：%s",
    (q) => {
      expect(asksAvailability(q)).toBe(false);
    },
  );

  it.each([
    "明日の14時って空いてますか？",
    "今から行っても大丈夫？",
    "予約できますか",
    "予約をキャンセルしたい",
    "土曜の空き状況は？",
    "明日10時いける？",
    "明日の10時って大丈夫？",
    "予約枠ある？",
  ])(
    "空き状況・予約可否の質問：%s",
    (q) => {
      expect(asksAvailability(q)).toBe(true);
    },
  );

  it.each(["営業時間は？", "カットはいくら？", "駐車場はありますか？", "パーマとカラーって同時にできますか？"])(
    "予約以外の質問：%s",
    (q) => {
      expect(asksAvailability(q)).toBe(false);
    },
  );
});

describe("参照データとプロンプト", () => {
  it("< > を全角にし、制御文字を除く", () => {
    expect(escapeData("<b>\u0007太字</b>")).toBe("＜b＞太字＜/b＞");
  });

  it("空欄は（未登録）、メニューは税込の金額、参照 ID を付ける", () => {
    const text = renderKnowledge(buildKnowledge(emptyShopRow(), FAQS, MENUS));
    expect(text).toContain("S:business_hours 営業時間: （未登録）");
    expect(text).toContain("M1 | 分類: cut | カット | 4,400円");
    expect(text).toContain("F1 | 分類: treatment | Q: パーマとカラーは同時にできますか？");
    expect(text.startsWith("<reference_data>")).toBe(true);
  });

  it("固定ルールに DB の内容を含めない（キャッシュが効き、データと命令を分離する）", () => {
    expect(SYSTEM_RULES).not.toContain("架空サロン");
    expect(SYSTEM_RULES).toContain("予約の空き状況");
    expect(SYSTEM_RULES).toContain("計算はしない");
  });

  it("formatYen はロケールに依存しない", () => {
    expect(formatYen(4400)).toBe("4,400円");
    expect(formatYen(1000000)).toBe("1,000,000円");
    expect(formatYen(0)).toBe("0円");
  });

  it("件数の上限を超えたら省略し、truncated にする（費用の上限）", () => {
    const many = Array.from({ length: KNOWLEDGE_LIMITS.maxFaqs + 5 }, (_, i) => ({ ...FAQS[0], id: `id-${i}` }));
    const k = buildKnowledge(shopRow(), many, MENUS);
    expect(k.faqs).toHaveLength(KNOWLEDGE_LIMITS.maxFaqs);
    expect(k.truncated).toBe(true);
  });

  it("店名以外がすべて空なら「根拠なし」", () => {
    expect(isKnowledgeEmpty(buildKnowledge(emptyShopRow({ shop_name: "架空" }), [], []))).toBe(true);
    expect(isKnowledgeEmpty(buildKnowledge(emptyShopRow({ parking: "なし" }), [], []))).toBe(false);
  });
});

describe("構造化出力のスキーマと解析", () => {
  it("API の制約に合わせ、object は additionalProperties: false・未対応のキーワードを使わない", () => {
    expect(AI_OUTPUT_SCHEMA.additionalProperties).toBe(false);
    const json = JSON.stringify(AI_OUTPUT_SCHEMA);
    for (const kw of ["maxLength", "minLength", "minimum", "maximum", "maxItems"]) expect(json).not.toContain(kw);
    expect([...AI_OUTPUT_SCHEMA.required].sort()).toEqual(Object.keys(AI_OUTPUT_SCHEMA.properties).sort());
  });

  it("重複した参照 ID はまとめ、理由は 300 文字に切り詰める", () => {
    const r = parseAiOutput(
      JSON.stringify({
        status: "cannot_answer",
        answer: "",
        category: "other",
        faq_refs: ["F1", "F1"],
        menu_refs: [],
        shop_refs: [],
        reason: "あ".repeat(400),
      }),
    );
    expect(r.ok && r.draft.faq_refs).toEqual(["F1"]);
    expect(r.ok && r.draft.reason.length).toBe(300);
  });
});
