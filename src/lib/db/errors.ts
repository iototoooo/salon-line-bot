/** DB アクセスの失敗。メッセージには個人情報を含めない */
export class DbError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string | undefined,
  ) {
    super(`db: ${operation} failed${code ? ` (${code})` : ""}`);
    this.name = "DbError";
  }
}

type Result<T> = { data: T | null; error: { message: string; code?: string } | null };

/** Supabase の結果からデータを取り出す。エラーなら DbError を投げる */
export function unwrap<T>(operation: string, result: Result<T>): T | null {
  if (result.error) throw new DbError(operation, result.error.code);
  return result.data;
}
