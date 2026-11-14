import { isShopKnowledgeField, type Knowledge, knowledgeText } from "./knowledge";
import type { AiDraft } from "./output";

/**
 * AI の回答をコード側で検証する（AI の自己申告や確信度には依存しない）。
 * 1 つでも問題があれば不採用にし、呼び出し側で定型文（確認が必要です）に差し替える。
 *
 * 検出できる範囲の限界（テストで確認済みの範囲のみ保証する）
 *   - 金額は「4,400円」「¥4400」「4400 円」「1万円」「5千円」「1.2万円」など算用数字の表記を照合する。
 *     単位のない 3 桁以上の数字・「えん」「yen」・百の位を含む表記は照合できないため不採用にする（漢数字のみの金額は対象外）
 *   - メニューの価格は、同じ区切り（。、改行）にそのメニュー名がある場合だけ許可する
 *   - 予約可否の断定は代表的な言い回しと「日時＋大丈夫・可能など」の組み合わせで検出する
 *   - 営業時間などの数字（時刻）が登録内容と一致するかは照合しない（根拠の項目が実在することだけを確認する）
 */

export type GuardFailure =
  | "empty_answer"
  | "too_long"
  | "markup_leak"
  | "no_source"
  | "unknown_ref"
  | "empty_shop_ref"
  | "availability_claim"
  | "unregistered_price"
  | "ambiguous_price"
  | "unknown_phone"
  | "unknown_url";

export type GuardResult = { ok: true } | { ok: false; reason: GuardFailure };

/** お客様へ送る回答の最大文字数（プロンプトでは 200 文字程度を指示） */
export const MAX_ANSWER_CHARS = 500;

/** NFKC で全角英数字・記号を半角にし、数字の間のダッシュ類（ー − ‐ – — ―）を "-" にそろえる */
const normalize = (text: string) => text.normalize("NFKC").replace(/(\d)\s*[ー−‐‑–—―－]\s*(?=\d)/g, "$1-");

/** 日時の表現（時刻・日付・曜日・相対日） */
const DATETIME = /\d{1,2}\s*(時|:\d{2})|明日|明後日|あした|本日|今日|きょう|今週|来週|今夜|今から|\d{1,2}\s*[/月]\s*\d{1,2}|[月火水木金土日]曜/;

// ---------------------------------------------------------------------------
// 予約
// ---------------------------------------------------------------------------

/** 空き状況・予約の可否・確定を断定する表現（肯定・否定とも。AI には答えさせない） */
const AVAILABILITY_CLAIMS: RegExp[] = [
  /空いて(い)?(ます|おります|る|ない|いません|おりません)/,
  /空き(が|は)?(あり|ござい|な(い|し))/,
  /満席|埋まって/,
  /予約(は|が|を)?(可能|でき(ます|る)|いただけ|お取り|承り|確定|完了|受け付け|取れ|とれ|お受け)/,
  /お取り(しました|いたしました|できます|いたします|しておきます)/,
  /(お待ちして(い)?ます|お待ちしております|お越しください).{0,15}(\d{1,2}時|明日|本日|今日|明後日)/,
  /(\d{1,2}時|明日|本日|今日|明後日).{0,15}(お待ちして(い)?ます|お待ちしております|お越しください)/,
  /空席|予約枠|お席を?(ご用意|お取り|確保)/,
];

/** 日時と組み合わさると「その日時は対応できる」という意味になる表現 */
const AVAILABILITY_WORDS_WITH_DATETIME = /大丈夫|可能|OK|ok|オーケー|ご用意|ご案内でき|対応でき|お受けでき|いけます|行けます|問題(あり|ござい)ません/;

/** 回答が空き状況・予約可否を断定している */
export function hasAvailabilityClaim(answer: string): boolean {
  const s = normalize(answer);
  if (AVAILABILITY_CLAIMS.some((re) => re.test(s))) return true;
  // 例：「明日10時は大丈夫です」「土曜日もご案内可能です」
  return DATETIME.test(s) && AVAILABILITY_WORDS_WITH_DATETIME.test(s);
}

/** 予約の規定（キャンセル料など）は FAQ で答えられるため、予約可否の判定から除く */
const RESERVATION_POLICY_WORDS = /キャンセル(料|ポリシー|規定|の規定|について(の)?(決まり|ルール))|予約(方法|の方法|の仕方)/g;

/** お客様の文が、空き状況・予約の可否・予約の変更・キャンセルを尋ねている */
const AVAILABILITY_QUESTIONS =
  /空いて|空き(状況|は|が|あり)|空席|予約枠|予約(でき|可能|取れ|とれ|したい|お願い|を?入れ|を?変更|の変更|を?キャンセル|のキャンセル|を?取り)|キャンセル|(行って|いって|伺って|行け|いけ|伺え)(も)?(大丈夫|いい|いけ|ます)|今から/;
/** 日時と組み合わさると空き状況の質問になる表現（例：「明日10時いける？」「明日の10時って大丈夫？」） */
const AVAILABILITY_QUESTION_WITH_DATETIME = /大丈夫|いける|行ける|いけます|行けます|可能|OK|ok|空|入れ|お願いでき|伺え|行って|いって/;

export function asksAvailability(question: string): boolean {
  const s = normalize(question).replace(RESERVATION_POLICY_WORDS, "");
  if (AVAILABILITY_QUESTIONS.test(s)) return true;
  return DATETIME.test(s) && AVAILABILITY_QUESTION_WITH_DATETIME.test(s);
}

/** 予約の変更・キャンセル（オーナーの対応が必要） */
export function asksReservationChange(question: string): boolean {
  const s = normalize(question).replace(RESERVATION_POLICY_WORDS, "");
  return /キャンセル|変更|取り消|日にちを?(変え|ずら)|時間を?(変え|ずら)/.test(s);
}

// ---------------------------------------------------------------------------
// 金額・電話番号・URL
// ---------------------------------------------------------------------------

/** 文中の金額（円）を取り出す */
export function extractYenAmounts(text: string): number[] {
  const out: number[] = [];
  const num = (v: string) => Number(v.replace(/,/g, ""));
  let s = normalize(text).replace(/，/g, ",");
  // 1万円 / 1.2万円 / 1万5千円 / 1万5000円
  s = s.replace(/(\d+(?:\.\d+)?)\s*万\s*(?:(\d)\s*千)?\s*(\d{1,4})?\s*円/g, (_m, man: string, sen?: string, rest?: string) => {
    out.push(Math.round(Number(man) * 10_000) + (sen ? Number(sen) * 1000 : 0) + (rest ? Number(rest) : 0));
    return " ";
  });
  // 5千円 / 5.5千円
  s = s.replace(/(\d+(?:\.\d+)?)\s*千\s*円/g, (_m, sen: string) => {
    out.push(Math.round(Number(sen) * 1000));
    return " ";
  });
  // ¥4,400 / \4400（NFKC で ￥ は ¥ になる）
  s = s.replace(/[¥\\]\s*(\d{1,3}(?:,\d{3})+|\d+)/g, (_m, v: string) => {
    out.push(num(v));
    return " ";
  });
  // 4,400円 / 4400 円
  s.replace(/(\d{1,3}(?:,\d{3})+|\d+)\s*円/g, (_m, v: string) => {
    out.push(num(v));
    return " ";
  });
  return out;
}

/**
 * 金額らしいが extractYenAmounts で正しく読み取れない表記（照合できないため不採用にする）。
 *   - 「えん」「yen」「JPY」、「5千5百円」のような百の位を含む表記
 *   - 単位のない 3 桁以上の数字（「カットは4400です」「3,000〜5,000円」の前半など）
 * 時刻・所要時間・電話番号・郵便番号など、金額以外とわかる数字は除外してから判定する。
 */
export function hasAmbiguousAmount(text: string): boolean {
  let s = normalize(text).replace(/，/g, ",");
  if (/えん|yen|jpy|百\s*円|\d\s*百|[千万]\s*\d+\s*百/i.test(s)) return true;
  s = s
    .replace(/(?:\+81[-\s]?|0)\d{1,4}[-\s(]?\d{1,4}[-\s)]?\d{3,4}/g, " ") // 電話番号
    .replace(/\d{3}-\d{4}/g, " ") // 郵便番号
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\d+(?:\.\d+)?\s*万\s*(?:\d\s*千)?\s*\d{0,4}\s*円/g, " ")
    .replace(/\d+(?:\.\d+)?\s*千\s*円/g, " ")
    .replace(/[¥\\]\s*(\d{1,3}(?:,\d{3})+|\d+)/g, " ")
    .replace(/(\d{1,3}(?:,\d{3})+|\d+)\s*円/g, " ")
    .replace(/\d{1,2}\s*:\s*\d{2}/g, " ") // 時刻
    .replace(/\d+\s*(分|時間|時|台|件|名|人|歳|回|年|月|日|週|cm|mm|%|％|階|F|号|番|丁目)/gi, " ");
  return /\d{3,}|\d{1,3}(?:,\d{3})+/.test(s);
}

/** 文中の電話番号（数字のみに正規化。+81 は 0 に置き換える） */
export function extractPhoneNumbers(text: string): string[] {
  const s = normalize(text);
  const matches = s.match(/(?:\+81[-\s]?|0)\d{1,4}[-\s(]?\d{1,4}[-\s)]?\d{3,4}/g) ?? [];
  return matches.map((m) => m.replace(/^\+81[-\s]?/, "0").replace(/\D/g, ""));
}

/** 文中の URL・ドメイン名（スキームなしの www.example.com なども含む。小文字にそろえる） */
export function extractUrls(text: string): string[] {
  const s = normalize(text);
  const withScheme = (s.match(/https?:\/\/[^\s<>「」（）()、。"']+/g) ?? []).map((u) => u.replace(/[.,!?]+$/, ""));
  const rest = s.replace(/https?:\/\/[^\s<>「」（）()、。"']+/g, " ");
  const domains = rest.match(/(?<![@\w.-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>「」（）()、。"']*)?/gi) ?? [];
  return [...withScheme, ...domains.map((d) => d.replace(/[.,!?]+$/, ""))].map((u) => u.toLowerCase());
}

/** 文を「。」「、」「改行」などで区切る（金額とメニュー名の対応を確かめる単位） */
function splitClauses(text: string): string[] {
  return normalize(text)
    .split(/[。、\n!?;]/)
    .map((c) => c.trim())
    .filter(Boolean);
}

const MARKUP_LEAK = /<\/?(reference_data|customer_message)|＜\/?(reference_data|customer_message)|厳守するルール/;

// ---------------------------------------------------------------------------
// 回答（answered）の検証
// ---------------------------------------------------------------------------

export function checkAnsweredDraft(draft: AiDraft, knowledge: Knowledge): GuardResult {
  const answer = draft.answer.trim();
  if (!answer) return fail("empty_answer");
  if (answer.length > MAX_ANSWER_CHARS) return fail("too_long");
  if (MARKUP_LEAK.test(answer)) return fail("markup_leak");

  // 根拠の実在（存在しない参照 ID・空欄の店舗項目を根拠にしていないか）
  if (draft.faq_refs.length + draft.menu_refs.length + draft.shop_refs.length === 0) return fail("no_source");
  const faqs = draft.faq_refs.map((r) => knowledge.faqs.find((f) => f.ref === r));
  const menus = draft.menu_refs.map((r) => knowledge.menus.find((m) => m.ref === r));
  if (faqs.some((f) => !f) || menus.some((m) => !m)) return fail("unknown_ref");
  const shopFields: string[] = [];
  for (const ref of draft.shop_refs) {
    const field = ref.startsWith("S:") ? ref.slice(2) : "";
    if (!isShopKnowledgeField(field)) return fail("unknown_ref");
    if (!knowledge.shop[field]) return fail("empty_shop_ref");
    shopFields.push(knowledge.shop[field]);
  }

  // 予約可否の断定
  if (hasAvailabilityClaim(answer)) return fail("availability_claim");

  // 金額：読み取れない表記は不採用（フェイルクローズ）
  if (hasAmbiguousAmount(answer)) return fail("ambiguous_price");
  // 金額は区切り（。、改行）ごとに照合する。メニューの価格は、同じ区切りにそのメニュー名がある場合だけ許可する
  // （「パーマは4,400円」のように別メニューの価格を流用した回答を防ぐ）。
  // 根拠の FAQ・店舗情報・メニュー備考の文章に書かれた金額は、そのまま引用したものとして許可する。
  const quoted = new Set<number>();
  for (const m of menus) for (const a of extractYenAmounts(`${m!.priceNote} ${m!.description}`)) quoted.add(a);
  for (const f of faqs) for (const a of extractYenAmounts(`${f!.question} ${f!.answer}`)) quoted.add(a);
  for (const t of shopFields) for (const a of extractYenAmounts(t)) quoted.add(a);
  const clauses = splitClauses(answer);
  const menusNamedIn = (clause: string) => menus.filter((m) => clause.includes(normalize(m!.name)));
  for (let i = 0; i < clauses.length; i++) {
    const amounts = extractYenAmounts(clauses[i]);
    if (amounts.length === 0) continue;
    // 同じ区切りにメニュー名があればそのメニューだけ、なければ直前の区切りのメニュー名を対象にする
    // （「カットの料金は、4,400円です」のように読点で区切られる場合）
    let named = menusNamedIn(clauses[i]);
    if (named.length === 0 && i > 0) named = menusNamedIn(clauses[i - 1]);
    const allowed = new Set(named.map((m) => m!.price));
    if (amounts.some((a) => !quoted.has(a) && !allowed.has(a))) return fail("unregistered_price");
  }

  // 電話番号・URL：登録情報にあるものだけ
  const source = knowledgeText(knowledge);
  const knownPhones = new Set(extractPhoneNumbers(source));
  if (extractPhoneNumbers(answer).some((p) => !knownPhones.has(p))) return fail("unknown_phone");
  const normalizedSource = normalize(source).toLowerCase();
  if (extractUrls(answer).some((u) => !normalizedSource.includes(u))) return fail("unknown_url");

  return { ok: true };
}

const fail = (reason: GuardFailure): GuardResult => ({ ok: false, reason });

/** AI の自由記述（判定理由）を保存する前に、電話番号・メールアドレス・LINE のユーザー ID を伏せる */
export function maskPersonalInfo(text: string): string {
  // 全角の数字・英字・記号だけを半角にする（括弧など本文の表記は変えない）
  const s = text
    .replace(/[０-９Ａ-Ｚａ-ｚ＠．＋]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/(\d)\s*[ー−‐‑–—―－]\s*(?=\d)/g, "$1-");
  return s
    .replace(/U[0-9a-f]{32}/g, "[ID省略]")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[メール省略]")
    .replace(/(?:\+81[-\s]?|0)\d{1,4}[-\s(]?\d{1,4}[-\s)]?\d{3,4}/g, "[電話番号省略]");
}
