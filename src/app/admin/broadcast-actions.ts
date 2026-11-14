"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/admin/action-state";
import * as core from "@/lib/admin/broadcast-actions";
import { readAdminModes } from "@/lib/admin/mode";
import { requireAdmin } from "@/lib/admin/session";
import { SupabaseBroadcastStatusStore } from "@/lib/db/broadcasts";
import { createLineBroadcastApi } from "@/lib/line/broadcast-client";
import { createHttpLinePushClient } from "@/lib/line/client";
import { createServerSupabaseClient, readSupabaseServerConfig } from "@/lib/supabase/server";

/**
 * 一斉配信の Server Action（バッチ 4）。先頭で必ず requireAdmin を確認する。
 * LINE への送信は安全スイッチ（LINE_BROADCAST_MODE=live）と ADMIN_WRITE_MODE=enabled の両方が必要（判定は core 側）。
 */

function deps(): core.BroadcastDeps {
  const token = (process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "").trim();
  const modes = readAdminModes();
  let store: core.BroadcastDeps["store"] = null;
  try {
    const config = readSupabaseServerConfig();
    if (config) store = new SupabaseBroadcastStatusStore(createServerSupabaseClient(config));
  } catch {
    store = null;
  }
  return {
    api: token ? createLineBroadcastApi(token) : null,
    // 送信用のクライアントは、送信が許可されているときだけ作る
    push: token && modes.lineSendEnabled ? createHttpLinePushClient(token) : null,
    store,
    newRetryKey: () => crypto.randomUUID(),
    now: Date.now,
  };
}

async function ctx() {
  const { db, user } = await requireAdmin();
  return { db, user, modes: readAdminModes() };
}

function refresh(id?: string) {
  revalidatePath("/admin/broadcasts");
  if (id) revalidatePath(`/admin/broadcasts/${id}`);
}

export async function createDraftAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const result = await core.createDraft(await ctx(), fd);
  if (result.status === "success" && result.id) {
    refresh();
    redirect(`/admin/broadcasts/${result.id}`);
  }
  return result;
}

export async function updateDraftAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const result = await core.updateDraft(await ctx(), fd);
  if (result.status === "success") refresh(String(fd.get("id")));
  return result;
}

export async function deleteDraftAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const result = await core.deleteDraft(await ctx(), fd);
  if (result.status === "success") {
    refresh();
    redirect("/admin/broadcasts");
  }
  return result;
}

export async function sendTestAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const result = await core.sendTest(await ctx(), fd, deps());
  refresh(String(fd.get("id")));
  return result;
}

export async function sendBroadcastAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const result = await core.sendBroadcast(await ctx(), fd, deps());
  refresh(String(fd.get("id")));
  return result;
}
