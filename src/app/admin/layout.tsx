import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { logoutAction } from "@/app/login/actions";
import { requireAdmin } from "@/lib/admin/session";

export const metadata: Metadata = {
  title: "管理画面｜美容室LINE自動応答",
  robots: { index: false, follow: false },
};

const NAV = [
  { href: "/admin", label: "ホーム" },
  { href: "/admin/inbox", label: "未対応一覧" },
  { href: "/admin/conversations", label: "会話ログ" },
  { href: "/admin/faqs", label: "FAQ" },
  { href: "/admin/menus", label: "メニュー・料金" },
  { href: "/admin/settings", label: "店舗情報・設定" },
  { href: "/admin/answer-test", label: "回答テスト" },
  { href: "/admin/broadcasts", label: "お知らせ配信" },
] as const;

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-950">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Link href="/admin" className="font-bold">
            管理画面
          </Link>
          <Suspense fallback={null}>
            <SignedInUser />
          </Suspense>
        </div>
        <nav aria-label="管理メニュー" className="mx-auto w-full max-w-4xl overflow-x-auto px-4 pb-2">
          <ul className="flex gap-1 text-sm">
            {NAV.map((n) => (
              <li key={n.href}>
                <Link
                  href={n.href}
                  className="block whitespace-nowrap rounded-md px-3 py-1.5 hover:bg-stone-100 dark:hover:bg-stone-800"
                >
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-6">{children}</main>
    </div>
  );
}

async function SignedInUser() {
  const { user } = await requireAdmin();
  return (
    <form action={logoutAction} className="flex items-center gap-3 text-sm">
      <span className="text-stone-600 dark:text-stone-400">{user.email ?? "管理者"}</span>
      <button type="submit" className="rounded-md border border-stone-300 px-3 py-1 hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800">
        ログアウト
      </button>
    </form>
  );
}
