/**
 * Webhook イベントの処理状況ストア（重複防止・返信トークンの使用管理・停止検出）。
 *
 * 実装
 *   - SupabaseWebhookEventStore（supabase-event-store.ts）: 本番用。line_webhook_events に永続化
 *   - InMemoryWebhookEventStore（このファイル）          : 開発・テスト専用。永続化しない
 *
 * LINE 仕様に基づく前提
 *   - webhookEventId でイベントの重複を検出する
 *   - replyToken は原則 1 回のみ、受信後 1 分以内しか使えない
 *   - LINE の再送は 2xx 応答後の処理失敗を回復しない → 停止イベントは自前で検出する
 */
export type EventFinalStatus = "done" | "skipped" | "failed";
/**
 * 返信の結果。sent: LINE が受理（2xx） / simulated: dry-run のため未送信 /
 * failed: LINE が拒否（未送信） / unknown: 成否不明（再送しない）
 */
export type ReplyResult = "sent" | "simulated" | "failed" | "unknown";

export type ClaimInput = {
  webhookEventId: string;
  eventType: string;
  isRedelivery: boolean;
  /** イベント発生時刻（ミリ秒） */
  eventTimestamp?: number;
};

export type FinishOptions = {
  /** 個人情報・本文を含めないエラー概要 */
  error?: string;
  /** 将来のオーナー通知の対象にする */
  needsOwnerNotification?: boolean;
};

export type StalledEvent = { webhookEventId: string; eventType: string; replyStatus: string };

export interface WebhookEventStore {
  /** 処理権を取得する。初回なら true、既に記録済みなら false。並列でも true は 1 回だけ */
  claim(input: ClaimInput): Promise<boolean>;
  /**
   * 返信トークンを使う直前に呼ぶ。未使用・処理中・返信期限内なら true（以後は false）。
   * false のときは返信しないこと。
   */
  beginReply(webhookEventId: string): Promise<boolean>;
  /** 返信 API の結果を記録する。成否不明は unknown（再送しない） */
  recordReplyResult(webhookEventId: string, result: ReplyResult): Promise<void>;
  /** 処理結果を記録する（processing からのみ） */
  finish(webhookEventId: string, status: EventFinalStatus, options?: FinishOptions): Promise<void>;
  /** 一定時間 processing のままのイベントを停止扱いにし、要通知にする */
  markStalled(olderThanMs?: number): Promise<StalledEvent[]>;
}

export class WebhookEventStoreError extends Error {
  constructor(operation: string, detail: string) {
    super(`webhook event store: ${operation} failed (${detail})`);
    this.name = "WebhookEventStoreError";
  }
}

/** 返信トークンの使用期限。LINE 仕様（受信後 1 分以内）に 10 秒の安全余裕を持たせる */
export const REPLY_WINDOW_MS = 50_000;
/** 停止とみなすまでの時間（返信期限より十分長く） */
export const DEFAULT_STALLED_AFTER_MS = 5 * 60_000;
export const MIN_STALLED_AFTER_MS = 2 * 60_000;

type Entry = {
  eventType: string;
  status: "processing" | EventFinalStatus | "abandoned";
  replyStatus: "none" | "sending" | ReplyResult;
  receivedAt: number;
  replyDeadline: number;
  error?: string;
  needsOwnerNotification: boolean;
};

/**
 * インメモリ実装（開発・テスト専用）。
 *
 * 注意：プロセス内でしか重複を防げない。サーバーレス環境ではインスタンスごとに
 * 状態が分かれ、再起動で消えるため、永続的な重複防止にはならない。
 */
export class InMemoryWebhookEventStore implements WebhookEventStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  async claim({ webhookEventId, eventType }: ClaimInput): Promise<boolean> {
    this.evict();
    if (this.entries.has(webhookEventId)) return false;
    const t = this.now();
    this.entries.set(webhookEventId, {
      eventType,
      status: "processing",
      replyStatus: "none",
      receivedAt: t,
      replyDeadline: t + REPLY_WINDOW_MS,
      needsOwnerNotification: false,
    });
    return true;
  }

  async beginReply(webhookEventId: string): Promise<boolean> {
    const e = this.entries.get(webhookEventId);
    if (!e || e.status !== "processing" || e.replyStatus !== "none" || this.now() >= e.replyDeadline) {
      return false;
    }
    e.replyStatus = "sending";
    return true;
  }

  async recordReplyResult(webhookEventId: string, result: ReplyResult): Promise<void> {
    const e = this.entries.get(webhookEventId);
    if (e?.replyStatus === "sending") e.replyStatus = result;
  }

  async finish(webhookEventId: string, status: EventFinalStatus, options: FinishOptions = {}): Promise<void> {
    const e = this.entries.get(webhookEventId);
    if (!e || e.status !== "processing") return;
    e.status = status;
    e.error = options.error?.slice(0, 300);
    e.needsOwnerNotification ||= options.needsOwnerNotification ?? false;
    if (e.replyStatus === "sending") e.replyStatus = "unknown";
  }

  async markStalled(olderThanMs = DEFAULT_STALLED_AFTER_MS): Promise<StalledEvent[]> {
    if (olderThanMs < MIN_STALLED_AFTER_MS) throw new Error("olderThanMs must be at least 2 minutes");
    const cutoff = this.now() - olderThanMs;
    const stalled: StalledEvent[] = [];
    for (const [id, e] of this.entries) {
      if (e.status === "processing" && e.receivedAt < cutoff) {
        e.status = "abandoned";
        e.needsOwnerNotification = true;
        if (e.replyStatus === "sending") e.replyStatus = "unknown";
        stalled.push({ webhookEventId: id, eventType: e.eventType, replyStatus: e.replyStatus });
      }
    }
    return stalled;
  }

  /** テスト用 */
  statusOf(webhookEventId: string) {
    return this.entries.get(webhookEventId)?.status;
  }

  /** テスト用 */
  entryOf(webhookEventId: string): Readonly<Entry> | undefined {
    return this.entries.get(webhookEventId);
  }

  private evict() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, e] of this.entries) {
      if (e.receivedAt < cutoff || this.entries.size > this.maxEntries) this.entries.delete(id);
      else break; // Map は挿入順なので、古いものから順に見ている
    }
  }
}
