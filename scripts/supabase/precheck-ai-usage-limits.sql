-- =============================================================================
-- 6 本目（20261113000000_ai_usage_limits.sql）の適用前チェック（読み取り専用）
--
-- SELECT 1 文のみ。データ・スキーマは変更しない。
--   supabase db query --remote=dnortggovlwgcdeoadbf --read-only -f scripts/supabase/precheck-ai-usage-limits.sql
-- 全行 OK なら適用可能。NG があれば適用しない。
-- =============================================================================
with checks(item, ok, detail) as (
  select '適用履歴が 5 本（1〜5 本目）で、6 本目は未適用',
         (select array_agg(version order by version) from supabase_migrations.schema_migrations)
           = array['20261110000000', '20261110010000', '20261110020000', '20261111000000', '20261112000000']::text[],
         coalesce((select string_agg(version, ', ' order by version) from supabase_migrations.schema_migrations), '(なし)')
  union all
  select '追加するテーブル ai_usage_reservations がまだ存在しない',
         to_regclass('public.ai_usage_reservations') is null,
         ''
  union all
  select '追加する関数 reserve_ai_usage がまだ存在しない（同名の関数もない）',
         not exists (select 1 from pg_proc where proname = 'reserve_ai_usage'),
         ''
  union all
  select '追加するインデックス名がまだ存在しない',
         to_regclass('public.ai_usage_reservations_date_idx') is null
         and to_regclass('public.ai_usage_reservations_user_idx') is null,
         ''
  union all
  select 'public のテーブルが想定の 7 つだけ',
         (select array_agg(relname::text order by relname) from pg_class
           where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm', 'f'))
           = array['admin_users', 'broadcasts', 'conversations', 'faqs', 'line_webhook_events', 'menus', 'shop_settings'],
         (select string_agg(relname::text, ', ' order by relname) from pg_class
           where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm', 'f'))
  union all
  select '全テーブルで RLS が有効',
         not exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity),
         ''
  union all
  select 'anon は public の全テーブルに権限なし',
         not exists (select 1 from pg_class c
                      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
                        and has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')),
         ''
  union all
  -- 関数はロック後の件数を新しい状態で数えるため READ COMMITTED を前提にしている
  select '既定のトランザクション分離レベルが read committed（データベース）',
         current_setting('default_transaction_isolation') = 'read committed',
         current_setting('default_transaction_isolation')
  union all
  select 'service_role・authenticator にロール単位の分離レベル設定がない',
         not exists (select 1 from pg_db_role_setting s
                      join pg_roles r on r.oid = s.setrole
                     where r.rolname in ('service_role', 'authenticator')
                       and exists (select 1 from unnest(s.setconfig) cfg where cfg like 'default_transaction_isolation=%')),
         coalesce((select string_agg(r.rolname || ': ' || array_to_string(s.setconfig, ','), ' / ')
                     from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
                    where r.rolname in ('service_role', 'authenticator')), '(設定なし)')
  union all
  select '関数が使う sha256() がある（PostgreSQL 11 以降の標準関数）',
         to_regprocedure('pg_catalog.sha256(bytea)') is not null,
         current_setting('server_version')
  union all
  select 'タイムゾーン Asia/Tokyo を使える（日本時間の日付の判定）',
         exists (select 1 from pg_timezone_names where name = 'Asia/Tokyo'),
         (now() at time zone 'Asia/Tokyo')::text
  union all
  select 'shop_settings：1 行・自動応答は OFF',
         (select count(*) from public.shop_settings) = 1
         and (select not bot_enabled from public.shop_settings where id = 1),
         ''
  union all
  select '既存データの行数（参考：conversations / line_webhook_events / faqs / menus）',
         true,
         (select count(*) from public.conversations)::text || ' / ' || (select count(*) from public.line_webhook_events)::text
           || ' / ' || (select count(*) from public.faqs)::text || ' / ' || (select count(*) from public.menus)::text
)
select case when ok then 'OK' else 'NG' end as result, item, detail
from checks
order by ok, item;
