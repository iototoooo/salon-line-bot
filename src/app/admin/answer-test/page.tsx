import { Suspense } from "react";
import { Card, Loading, ModeBanner, Notice, PageTitle } from "@/components/admin/ui";
import { ANSWER_TEST_LIMIT_PER_HOUR } from "@/lib/admin/conversation-actions";
import { readAdminModes } from "@/lib/admin/mode";
import { requireAdmin } from "@/lib/admin/session";
import { AnswerTestForm } from "./answer-test-form";

export default function AnswerTestPage() {
  return (
    <>
      <PageTitle
        title="回答テスト"
        description="LINE に送らずに、登録した FAQ・メニュー・店舗情報で AI がどう答えるかを確認します。会話ログには保存しません。"
      />
      <Suspense fallback={<Loading />}>
        <AnswerTest />
      </Suspense>
    </>
  );
}

async function AnswerTest() {
  await requireAdmin();
  const modes = readAdminModes();
  return (
    <div className="flex flex-col gap-4">
      <ModeBanner modes={modes} />
      {modes.answerTestAiEnabled ? (
        <Notice tone="warn">
          AI（Claude API）を実際に呼び出します。1 回ごとに費用が発生します（上限：1 時間に {ANSWER_TEST_LIMIT_PER_HOUR} 回）。
        </Notice>
      ) : (
        <Notice>
          現在は AI を呼び出しません（費用はかかりません）。質問が長すぎる・登録情報が空などの、AI を呼ぶ前の判定だけを確認できます。
        </Notice>
      )}
      <Card>
        <AnswerTestForm />
      </Card>
    </div>
  );
}
