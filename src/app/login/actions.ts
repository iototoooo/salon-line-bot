"use server";

import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/admin/action-state";
import { login } from "@/lib/admin/login-core";
import { createSessionClient } from "@/lib/admin/session";

export async function loginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let client = null;
  try {
    client = await createSessionClient();
  } catch {
    client = null;
  }
  const result = await login(client, formData);
  if (result.kind === "redirect") redirect(result.to);
  return result.state;
}

export async function logoutAction(): Promise<void> {
  try {
    const client = await createSessionClient();
    await client?.auth.signOut();
  } catch {
    // セッションがなくてもログイン画面へ戻す
  }
  redirect("/login");
}
