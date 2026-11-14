"use client";

import { createContext, type ReactNode, useActionState, useContext, useEffect, useRef } from "react";
import { type ActionState, IDLE } from "@/lib/admin/action-state";

/**
 * 管理画面の共通フォーム部品。
 * - ActionForm：Server Action を useActionState で呼び、結果のメッセージと項目ごとのエラーを表示する
 * - 送信中はボタンを無効にする（二重送信の防止）
 * - disabled（書き込み無効など）のときは送信ボタンを押せない。サーバー側でも同じ条件で拒否する
 */
export type FormAction = (state: ActionState, formData: FormData) => Promise<ActionState>;

const ErrorsCtx = createContext<Record<string, string>>({});

export function ActionForm({
  action,
  children,
  submitLabel,
  disabled = false,
  disabledReason,
  danger = false,
  className = "",
  resetOnSuccess = false,
}: {
  action: FormAction;
  children?: ReactNode;
  submitLabel: string;
  disabled?: boolean;
  disabledReason?: string;
  danger?: boolean;
  className?: string;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (resetOnSuccess && state.status === "success") formRef.current?.reset();
  }, [state, resetOnSuccess]);
  const fieldErrors = state.status === "error" ? (state.fieldErrors ?? {}) : {};
  return (
    <form ref={formRef} action={formAction} className={`flex flex-col gap-3 ${className}`}>
      <ErrorsCtx value={fieldErrors}>{children}</ErrorsCtx>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={disabled || pending}
          className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40 ${
            danger
              ? "bg-red-700 hover:bg-red-800"
              : "bg-stone-800 hover:bg-stone-900 dark:bg-stone-200 dark:text-stone-900"
          }`}
        >
          {pending ? "処理中…" : submitLabel}
        </button>
        {disabled && disabledReason ? <span className="text-xs text-stone-500">{disabledReason}</span> : null}
      </div>
      <StatusMessage state={state} />
    </form>
  );
}

export function StatusMessage({ state }: { state: ActionState }) {
  if (state.status === "idle") return null;
  const isError = state.status === "error";
  return (
    <p
      role={isError ? "alert" : "status"}
      className={`rounded-lg px-3 py-2 text-sm ${
        isError
          ? "bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-200"
          : "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"
      }`}
    >
      {state.message}
    </p>
  );
}

const inputClass =
  "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900 aria-[invalid=true]:border-red-600";

function Label({ name, label, hint, children }: { name: string; label: string; hint?: string; children: ReactNode }) {
  const error = useContext(ErrorsCtx)[name];
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint ? <span className="text-xs text-stone-500">{hint}</span> : null}
      {error ? (
        <span id={`${name}-error`} className="text-xs text-red-700 dark:text-red-300">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function TextField({
  name,
  label,
  defaultValue,
  hint,
  type = "text",
  maxLength,
  required,
  autoComplete,
  placeholder,
}: {
  name: string;
  label: string;
  defaultValue?: string | number | null;
  hint?: string;
  type?: "text" | "email" | "password" | "number" | "date";
  maxLength?: number;
  required?: boolean;
  autoComplete?: string;
  placeholder?: string;
}) {
  const error = useContext(ErrorsCtx)[name];
  return (
    <Label name={name} label={label} hint={hint}>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue ?? undefined}
        maxLength={maxLength}
        required={required}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : undefined}
        className={inputClass}
      />
    </Label>
  );
}

export function TextArea({
  name,
  label,
  defaultValue,
  hint,
  maxLength,
  rows = 4,
  required,
}: {
  name: string;
  label: string;
  defaultValue?: string | null;
  hint?: string;
  maxLength?: number;
  rows?: number;
  required?: boolean;
}) {
  const error = useContext(ErrorsCtx)[name];
  return (
    <Label name={name} label={label} hint={hint}>
      <textarea
        name={name}
        defaultValue={defaultValue ?? undefined}
        maxLength={maxLength}
        rows={rows}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : undefined}
        className={inputClass}
      />
    </Label>
  );
}

export function SelectField({
  name,
  label,
  options,
  defaultValue,
}: {
  name: string;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  defaultValue?: string;
}) {
  return (
    <Label name={name} label={label}>
      <select name={name} defaultValue={defaultValue} className={inputClass}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Label>
  );
}

export function CheckboxField({ name, label, defaultChecked }: { name: string; label: string; defaultChecked?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="h-4 w-4" />
      <span>{label}</span>
    </label>
  );
}

export function HiddenField({ name, value }: { name: string; value: string }) {
  return <input type="hidden" name={name} value={value} />;
}
