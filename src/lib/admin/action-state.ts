/**
 * 管理画面の Server Action の結果（フォームの useActionState で受け取る）。
 * message はそのまま画面に表示する日本語。内部エラーの詳細（DB のメッセージ等）は入れない。
 */
export type ActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "error"; message: string; fieldErrors?: Record<string, string> };

export const IDLE: ActionState = { status: "idle" };

export const ok = (message: string): ActionState => ({ status: "success", message });
export const fail = (message: string, fieldErrors?: Record<string, string>): ActionState => ({
  status: "error",
  message,
  fieldErrors,
});

/** DB エラーなど、原因を画面に出せない失敗 */
export const SAVE_FAILED = "保存できませんでした。時間をおいて再度お試しください。";
