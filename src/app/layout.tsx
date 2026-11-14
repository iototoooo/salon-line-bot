import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "美容室LINE自動応答システム",
  description:
    "LINEの問い合わせにAIが自動で回答し、回答できない質問はオーナーへ通知する美容室向けシステム",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
