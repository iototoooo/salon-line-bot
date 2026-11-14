import { after } from "next/server";
import { createResponderFromEnv } from "@/lib/bot/config";
import { createLineClientFromEnv, createWebhookEventStore } from "@/lib/line/config";
import { claimEvents, DEFAULT_FALLBACK_MESSAGE, processEvents } from "@/lib/line/process-events";
import { createWebhookHandler } from "@/lib/line/webhook-handler";
import { createOwnerNotifierFromEnv } from "@/lib/notify/config";

/**
 * LINE Messaging API の Webhook 受信口。
 * 返信内容は LINE_RESPONDER で切り替える（既定は Echo、ai で FAQ に基づく AI 応答）。
 *
 * 流れ：署名検証 → イベントを記録（重複除外）→ 200 → after() で返信 → オーナー通知（まとめ送信）
 */
const handler = createWebhookHandler(() => {
  const client = createLineClientFromEnv();
  const store = createWebhookEventStore();
  const respond = createResponderFromEnv();
  const notifier = createOwnerNotifierFromEnv();
  return {
    channelSecret: process.env.LINE_CHANNEL_SECRET ?? "",
    schedule: (task) => after(task),
    claimEvents: (events) => claimEvents(events, store, console),
    processEvents: (events) =>
      processEvents(
        events,
        {
          store,
          client,
          respond,
          fallbackMessage: DEFAULT_FALLBACK_MESSAGE,
          logger: console,
          notifyOwner: notifier ? (options) => notifier.flush(options) : undefined,
        },
        { alreadyClaimed: true },
      ),
    logger: console,
  };
});

export async function POST(request: Request): Promise<Response> {
  return handler(request);
}
