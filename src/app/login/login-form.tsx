"use client";

import { ActionForm, HiddenField, TextField } from "@/components/admin/form";
import { loginAction } from "./actions";

export function LoginForm({ next }: { next?: string }) {
  return (
    <ActionForm action={loginAction} submitLabel="ログイン">
      <TextField name="email" label="メールアドレス" type="email" autoComplete="username" required maxLength={254} />
      <TextField name="password" label="パスワード" type="password" autoComplete="current-password" required maxLength={200} />
      {next ? <HiddenField name="next" value={next} /> : null}
    </ActionForm>
  );
}
