const features = [
  {
    title: "AI自動応答",
    body: "営業時間・料金・駐車場などのよくある質問に、登録された情報だけをもとにLINEで自動返信します。",
  },
  {
    title: "オーナーへ通知",
    body: "AIが答えられない質問は「確認してご連絡します」と返し、オーナーのLINEへお知らせします。",
  },
  {
    title: "お知らせ配信",
    body: "臨時休業などを、テスト送信と送信数の確認をしてから友だち全員へ配信できます。",
  },
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-2">
        <span className="w-fit rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
          開発中（仮画面）
        </span>
        <h1 className="text-2xl font-bold leading-snug">
          美容室LINE自動応答システム
        </h1>
        <p className="text-sm leading-relaxed text-stone-600 dark:text-stone-400">
          LINE公式アカウントへのお問い合わせにAIが自動で回答するシステムです。
        </p>
      </header>

      <ul className="flex flex-col gap-3">
        {features.map((f) => (
          <li
            key={f.title}
            className="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900"
          >
            <h2 className="font-semibold">{f.title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-stone-600 dark:text-stone-400">
              {f.body}
            </p>
          </li>
        ))}
      </ul>

      <section className="rounded-xl bg-stone-100 p-4 text-sm leading-relaxed text-stone-700 dark:bg-stone-900/60 dark:text-stone-300">
        <p>
          予約の空き状況はAIでは回答しません。ご予約はお電話または予約ページからお願いします。
        </p>
      </section>

      <p className="mt-auto text-center text-xs text-stone-500">
        管理画面は準備中です
      </p>
    </main>
  );
}
