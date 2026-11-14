-- =============================================================================
-- 5 本目（20261112000000_conversation_ai_sources.sql）の適用前チェック（読み取り専用）
--
-- SELECT 1 文のみ。データ・スキーマは変更しない。
--   supabase db query --remote=dnortggovlwgcdeoadbf --read-only -f scripts/supabase/precheck-conversation-sources.sql
-- 全行 OK なら適用可能。NG があれば適用しない。
-- =============================================================================
with checks(item, ok, detail) as (
  select '適用履歴が 4 本（1〜4 本目）で、5 本目は未適用',
         (select array_agg(version order by version) from supabase_migrations.schema_migrations)
           = array['20261110000000', '20261110010000', '20261110020000', '20261111000000']::text[],
         coalesce((select string_agg(version, ', ' order by version) from supabase_migrations.schema_migrations), '(なし)')
  union all
  select '追加する 4 列がまだ存在しない',
         not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'conversations'
                        and column_name in ('source_faq_ids', 'source_menu_ids', 'source_shop_fields', 'ai_reason')),
         ''
  union all
  select '追加する制約名がまだ存在しない',
         not exists (select 1 from pg_constraint
                      where conname in ('conversations_source_faq_ids_check', 'conversations_source_menu_ids_check',
                                        'conversations_source_shop_fields_check', 'conversations_ai_reason_check')),
         ''
  union all
  select 'conversations の列が 4 本目適用後の 19 列のまま',
         (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'conversations') = 19,
         (select count(*)::text || ' 列' from information_schema.columns
           where table_schema = 'public' and table_name = 'conversations')
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
  select 'conversations のポリシーが 2 つ（参照・対応済み）',
         (select count(*) from pg_policies where schemaname = 'public' and tablename = 'conversations') = 2,
         (select string_agg(policyname, ', ' order by policyname) from pg_policies
           where schemaname = 'public' and tablename = 'conversations')
  union all
  select 'conversations：authenticated は参照のみ・更新は resolved_at / resolved_by の列だけ',
         has_table_privilege('authenticated', 'public.conversations', 'SELECT')
         and not has_table_privilege('authenticated', 'public.conversations', 'INSERT')
         and not has_table_privilege('authenticated', 'public.conversations', 'UPDATE')
         and has_column_privilege('authenticated', 'public.conversations', 'resolved_at', 'UPDATE')
         and not has_column_privilege('authenticated', 'public.conversations', 'bot_reply', 'UPDATE'),
         ''
  union all
  select 'conversations：anon は権限なし',
         not has_table_privilege('anon', 'public.conversations', 'SELECT')
         and not has_table_privilege('anon', 'public.conversations', 'INSERT'),
         ''
  union all
  select 'conversations：service_role は参照・追加・更新が可能（削除は不可）',
         has_table_privilege('service_role', 'public.conversations', 'SELECT')
         and has_table_privilege('service_role', 'public.conversations', 'INSERT')
         and has_table_privilege('service_role', 'public.conversations', 'UPDATE')
         and not has_table_privilege('service_role', 'public.conversations', 'DELETE'),
         ''
  union all
  select 'conversations の行数（既存の会話ログ）',
         true,
         (select count(*)::text || ' 行（0 行なら既存データへの影響なし。行があっても追加列は既定値になる）' from public.conversations)
  union all
  select 'shop_settings：1 行・自動応答は OFF',
         (select count(*) from public.shop_settings) = 1
         and (select not bot_enabled from public.shop_settings where id = 1),
         ''
  union all
  select 'faqs / menus / line_webhook_events の行数（参考）',
         true,
         (select count(*) from public.faqs)::text || ' / ' || (select count(*) from public.menus)::text || ' / '
           || (select count(*) from public.line_webhook_events)::text
  union all
  select 'conversations を使う関数（保持期間の削除）が存在する',
         to_regprocedure('private.purge_expired_data(interval,interval)') is not null,
         ''
)
select case when ok then 'OK' else 'NG' end as result, item, detail
from checks
order by ok, item;
