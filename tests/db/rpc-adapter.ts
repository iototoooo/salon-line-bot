import type { PGlite } from "@electric-sql/pglite";
import type { ServerSupabaseClient } from "@/lib/supabase/server";

/**
 * supabase-js の rpc() を PGlite 上の関数呼び出しに変換するテスト用アダプター。
 * PostgREST と同様に名前付き引数で service_role として実行する。
 * 実際の Supabase には接続しない。
 */
const SET_RETURNING = new Set(["mark_stalled_line_webhook_events"]);

export function pgliteRpcClient(db: PGlite, opts: { failWith?: () => Error | null } = {}): ServerSupabaseClient {
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    const injected = opts.failWith?.();
    if (injected) return { data: null, error: { message: injected.message, code: "TEST_FAILURE" } };

    if (!/^[a-z_]+$/.test(fn)) throw new Error("invalid function name");
    const keys = Object.keys(args).filter((k) => args[k] !== undefined);
    keys.forEach((k) => {
      if (!/^p_[a-z_]+$/.test(k)) throw new Error("invalid arg name");
    });
    const call = `public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
    const sql = SET_RETURNING.has(fn) ? `select * from ${call}` : `select ${call} as result`;

    try {
      await db.exec("set role service_role");
      const res = await db.query<Record<string, unknown>>(
        sql,
        keys.map((k) => args[k]),
      );
      const data = SET_RETURNING.has(fn) ? res.rows : res.rows[0]?.result;
      return { data, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message, code: "P0001" } };
    } finally {
      await db.exec("reset role");
    }
  };
  return { rpc } as unknown as ServerSupabaseClient;
}
