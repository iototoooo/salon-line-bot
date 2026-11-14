-- =============================================================================
-- 適用前チェック（読み取り専用・SELECT 1 文のみ）
-- 対象：salon-line-bot（Project Ref: dnortggovlwgcdeoadbf）の新規プロジェクト
--
-- 実行方法（どちらか）
--   CLI : npx supabase@3.1.0 db query --workdir <このリポジトリ> --remote=dnortggovlwgcdeoadbf --read-only -f scripts/supabase/preflight.sql
--   画面: https://supabase.com/dashboard/project/dnortggovlwgcdeoadbf/sql/new に貼り付けて実行
--
-- 判定：NG が 0 件で、要確認の行を確認済みならマイグレーションを適用してよい。
--   NG     … 適用しない。別プロジェクトに接続している、または前提が満たされていない
--   要確認 … 内容を確認してから判断する
--            （新規プロジェクトでは「既定権限」の行が要確認になる。3 本目のマイグレーションで解決する想定）
-- データの変更は一切行わない（CLI では --read-only でも保護される）。
-- =============================================================================
with
roles as (
  select
    (select oid from pg_roles where rolname = 'anon')          as anon,
    (select oid from pg_roles where rolname = 'authenticated') as authenticated,
    (select oid from pg_roles where rolname = 'service_role')  as service_role,
    (select rolbypassrls from pg_roles where rolname = 'service_role') as service_bypassrls
),
our_tables(t) as (values
  ('admin_users'), ('shop_settings'), ('faqs'), ('menus'),
  ('line_webhook_events'), ('conversations'), ('broadcasts')
),
existing_our_tables as (
  select string_agg(t, ', ' order by t) as names, count(*) as n
  from our_tables where to_regclass('public.' || t) is not null
),
public_tables as (
  select string_agg(c.relname, ', ' order by c.relname) as names, count(*) as n
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
),
public_functions as (
  select string_agg(p.proname, ', ' order by p.proname) as names, count(*) as n
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
),
-- マイグレーションは postgres ロールで実行される。
-- service_role の操作はこの既定権限（新規テーブル・関数に自動付与される権限）に依存している。
default_acl as (
  select a.defaclobjtype as objtype, x.grantee, x.privilege_type
  from pg_default_acl a, aclexplode(a.defaclacl) x
  where a.defaclnamespace = 'public'::regnamespace
    and a.defaclrole = (select oid from pg_roles where rolname = 'postgres')
),
checks(item, result, detail) as (
  select 'PostgreSQL のバージョンが 15 以上',
         case when current_setting('server_version_num')::int >= 150000 then 'OK' else 'NG' end,
         current_setting('server_version')
  union all
  select '接続先データベース名',
         case when current_database() = 'postgres' then 'OK' else '要確認' end,
         current_database()
  union all
  select 'Supabase の標準ロール（anon / authenticated / service_role）がある',
         case when anon is not null and authenticated is not null and service_role is not null
              then 'OK' else 'NG' end, ''
    from roles
  union all
  select 'service_role は RLS をバイパスする（BYPASSRLS）',
         case when service_bypassrls then 'OK' else 'NG' end, ''
    from roles
  union all
  select 'auth.users と auth.uid() がある（Supabase Auth）',
         case when to_regclass('auth.users') is not null and to_regprocedure('auth.uid()') is not null
              then 'OK' else 'NG' end, ''
  union all
  select 'gen_random_uuid() が使える',
         case when to_regprocedure('gen_random_uuid()') is not null then 'OK' else 'NG' end, ''
  union all
  select 'private スキーマがまだない',
         case when to_regnamespace('private') is null then 'OK' else 'NG' end,
         '既にある場合は適用済み、または別プロジェクトの可能性'
  union all
  select '本システムのテーブルがまだない（7 テーブル）',
         case when n = 0 then 'OK' else 'NG' end, coalesce(names, '')
    from existing_our_tables
  union all
  select 'public スキーマにテーブル・ビューが 1 つもない（新規プロジェクトである）',
         case when n = 0 then 'OK' else 'NG' end, coalesce(names, '')
    from public_tables
  union all
  select 'public スキーマに独自の関数がない',
         case when n = 0 then 'OK' else '要確認' end, coalesce(names, '')
    from public_functions
  union all
  select 'マイグレーション履歴テーブルがまだない',
         case when to_regclass('supabase_migrations.schema_migrations') is null then 'OK' else '要確認' end,
         'ある場合は supabase migration list --remote で履歴が空か確認する'
  union all
  -- 既定権限が不足していても、20261110020000_grant_service_role.sql で明示的に付与するため NG にはしない。
  -- ただし不足を見逃さないよう「要確認」として実際の既定権限を表示し、適用後に verify.sql の区分 5 で判定する。
  select '既定権限：新規テーブルに service_role の SELECT/INSERT/UPDATE/DELETE が付く',
         case when (select count(distinct privilege_type) from default_acl
                     where objtype = 'r' and grantee = roles.service_role
                       and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')) = 4
              then 'OK' else '要確認' end,
         '既定: ' || coalesce((select string_agg(distinct privilege_type, ',' order by privilege_type) from default_acl
                                where objtype = 'r' and grantee = roles.service_role), 'なし')
         || ' → 不足分は 20261110020000_grant_service_role.sql で明示付与。適用後に verify.sql「5 service_role」で確認'
    from roles
  -- 関数の EXECUTE はマイグレーション内で service_role に明示的に付与しているため、既定権限には依存しない
)
select item, result, detail
from checks
order by case result when 'NG' then 0 when '要確認' then 1 else 2 end, item;
