"use server";

import { revalidatePath } from "next/cache";
import { createClaudeAnswerModel, readClaudeConfig } from "@/lib/ai/claude-model";
import type { ActionState } from "@/lib/admin/action-state";
import { type AnswerTestState, markResolved, runAnswerTest } from "@/lib/admin/conversation-actions";
import { readAdminModes } from "@/lib/admin/mode";
import { requireAdmin } from "@/lib/admin/session";

/** 会話管理の Server Action（バッチ 3）。先頭で必ず requireAdmin を確認する */

export async function markResolvedAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { db, user } = await requireAdmin();
  const result = await markResolved({ db, user, modes: readAdminModes() }, fd);
  if (result.status === "success") {
    revalidatePath("/admin/inbox");
    revalidatePath("/admin/conversations");
    revalidatePath("/admin");
  }
  return result;
}

export async function answerTestAction(_: AnswerTestState, fd: FormData): Promise<AnswerTestState> {
  const { db, user } = await requireAdmin();
  const modes = readAdminModes();
  // 安全スイッチ（ADMIN_ANSWER_TEST_MODE=live）と API キーの両方があるときだけ、実際の Claude API を使う
  const config = modes.answerTestAiEnabled ? readClaudeConfig() : null;
  return runAnswerTest({ db, user, modes }, fd, { model: config ? createClaudeAnswerModel(config) : null });
}
