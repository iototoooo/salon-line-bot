import type { Metadata } from "next";
import { Suspense } from "react";
import { Loading, Notice } from "@/components/admin/ui";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "ログイン｜美容室LINE自動応答 管理画面" };

const ERRORS: Record<string, string> = {
  forbidden: "このアカウントには管理画面の権限がありません。",
  config: "ログインの設定がされていません（NEXT_PUBLIC_SUPABASE_URL・NEXT_PUBLIC_SUPABASE_ANON_KEY）。",
  unavailable: "ログイン状態を確認できませんでした。時間をおいて再度お試しください。",
};

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold">管理画面にログイン</h1>
        <p className="text-sm text-stone-600 dark:text-stone-400">美容室LINE自動応答システムのオーナー用画面です。</p>
      </header>
      {/* 読み込み中は入力欄を出さない（入れ替わりで入力内容が消えるのを防ぐ） */}
      <Suspense fallback={<Loading />}>
        <LoginBody searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function LoginBody({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;
  const next = typeof params.next === "string" ? params.next : undefined;
  return (
    <div className="flex flex-col gap-4">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <LoginForm next={next} />
    </div>
  );
}
