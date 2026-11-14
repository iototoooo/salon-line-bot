import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/**
 * Supabase 環境を最小限まねたスタブ（ロール・auth スキーマ・既定権限）。
 *
 * 既定権限は、対象プロジェクト（dnortggovlwgcdeoadbf）で 2026-11-10 に読み取り専用で確認した値に合わせている。
 *   postgres が public に作るテーブル → anon / authenticated / service_role に MAINTAIN, REFERENCES, TRIGGER, TRUNCATE のみ
 *   postgres が public に作る関数     → 既定権限なし（PostgreSQL 標準の PUBLIC への EXECUTE のみ）
 * SELECT / INSERT / UPDATE / DELETE は自動では付かないため、マイグレーションで明示的に付与する必要がある。
 */
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public
    grant maintain, references, trigger, truncate on tables to anon, authenticated, service_role;
`;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** 指定したマイグレーションだけを順に適用する（権限不足の再現など） */
export async function createDbWithMigrations(files: string[]): Promise<PGlite> {
  const db = await createSupabaseStubDb();
  for (const file of files) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

/** Supabase の新規プロジェクト相当（マイグレーション適用前）の空の DB */
export async function createSupabaseStubDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  return db;
}

/** 空の DB に全マイグレーションをファイル名順に適用する */
export async function createMigratedDb(): Promise<PGlite> {
  return createDbWithMigrations(migrationFiles());
}

/** service_role として SQL を実行する */
export async function asServiceRole<T>(db: PGlite, sql: string, params: unknown[] = []) {
  await db.exec("set role service_role");
  try {
    return await db.query<T>(sql, params);
  } finally {
    await db.exec("reset role");
  }
}
