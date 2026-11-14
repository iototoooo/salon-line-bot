// =============================================================================
// ブラウザ自動テスト中のサーバー（next dev）が、ローカル以外へ通信しないようにする安全装置。
// NODE_OPTIONS=--import で読み込み、fetch の宛先を 127.0.0.1 / localhost に限定する（それ以外は例外）。
// 本番の Supabase・LINE・Claude API には、設定の誤りがあっても接続できない。
// =============================================================================
const originalFetch = globalThis.fetch;
const ALLOWED = new Set(["127.0.0.1", "localhost", "[::1]"]);

globalThis.fetch = async function guardedFetch(input, init) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!ALLOWED.has(url.hostname)) {
    // 宛先のホスト名だけを出す（パス・クエリ・ヘッダーは出さない）
    console.error(`[e2e:network-guard] blocked request to ${url.hostname}`);
    throw new Error(`E2E network guard: requests to ${url.hostname} are not allowed`);
  }
  return originalFetch(input, init);
};
