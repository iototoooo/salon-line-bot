import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLineSignature, verifyLineSignature } from "@/lib/line/signature";
import { TEST_SECRET } from "./fixtures";

const enc = (s: string) => new TextEncoder().encode(s);

describe("verifyLineSignature", () => {
  const raw = '{"destination":"U1","events":[{"message":{"text":"カット料金は？ 😀"}}]}';

  it("正しい署名を受け入れる（HMAC-SHA256 → Base64）", () => {
    const sig = createHmac("sha256", TEST_SECRET).update(raw).digest("base64");
    expect(sig).toBe(createLineSignature(raw, TEST_SECRET));
    expect(verifyLineSignature(enc(raw), sig, TEST_SECRET)).toBe(true);
  });

  it("別のシークレットで作った署名を拒否する", () => {
    expect(verifyLineSignature(enc(raw), createLineSignature(raw, "other-secret"), TEST_SECRET)).toBe(false);
  });

  it("本文が 1 バイトでも変わると拒否する", () => {
    const sig = createLineSignature(raw, TEST_SECRET);
    expect(verifyLineSignature(enc(raw + " "), sig, TEST_SECRET)).toBe(false);
  });

  it("JSON を整形し直した本文では一致しない（生データで検証する必要がある）", () => {
    const sig = createLineSignature(raw, TEST_SECRET);
    const reserialized = JSON.stringify(JSON.parse(raw), null, 2);
    expect(verifyLineSignature(enc(reserialized), sig, TEST_SECRET)).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["空文字", ""],
    ["Base64 でない文字列", "not-a-signature!!"],
    ["長さの違う署名", Buffer.from("short").toString("base64")],
  ])("署名が %s なら拒否する", (_label, sig) => {
    expect(verifyLineSignature(enc(raw), sig as string | null | undefined, TEST_SECRET)).toBe(false);
  });

  it("正しい署名の後ろに余分な文字が付いていれば拒否する", () => {
    const sig = createLineSignature(raw, TEST_SECRET);
    expect(verifyLineSignature(enc(raw), `${sig}AA`, TEST_SECRET)).toBe(false);
    expect(verifyLineSignature(enc(raw), `${sig}\n`, TEST_SECRET)).toBe(false);
  });

  it("シークレット未設定なら常に拒否する", () => {
    expect(verifyLineSignature(enc(raw), createLineSignature(raw, ""), "")).toBe(false);
  });
});
