import { describe, expect, it } from "vitest";
import { InMemoryWebhookEventStore } from "@/lib/line/event-store";

// 注意：これはテスト用インメモリ実装の検証であり、永続的な重複防止（Supabase）の検証ではない
describe("InMemoryWebhookEventStore", () => {
  const input = (id: string) => ({ webhookEventId: id, eventType: "message", isRedelivery: false });

  it("同じ ID の 2 回目の claim は false", async () => {
    const store = new InMemoryWebhookEventStore();
    expect(await store.claim(input("a"))).toBe(true);
    expect(await store.claim(input("a"))).toBe(false);
    expect(await store.claim(input("b"))).toBe(true);
  });

  it("同時に claim しても true は 1 回だけ", async () => {
    const store = new InMemoryWebhookEventStore();
    const results = await Promise.all(Array.from({ length: 5 }, () => store.claim(input("same"))));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("finish で状態を記録する", async () => {
    const store = new InMemoryWebhookEventStore();
    await store.claim(input("a"));
    expect(store.statusOf("a")).toBe("processing");
    await store.finish("a", "done");
    expect(store.statusOf("a")).toBe("done");
  });

  it("TTL を過ぎた記録は削除される", async () => {
    let now = 0;
    const store = new InMemoryWebhookEventStore(1000, 100, () => now);
    await store.claim(input("a"));
    now = 2000;
    expect(await store.claim(input("a"))).toBe(true);
  });
});
