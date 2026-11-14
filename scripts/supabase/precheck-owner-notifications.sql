-- =============================================================================
-- 7 本目（20261114000000_owner_notifications.sql）の適用前チェック（読み取り専用）
--
-- SELECT 1 文のみ。データ・スキーマは変更しない。
--   supabase db query --remote=dnortggovlwgcdeoadbf --read-only -f scripts/supabase/precheck-owner-notifications.sql
-- 全行 OK なら適用可能。NG があれば適用しない（「参考」の行は判定に使わない情報）。
-- オーナーの LINE ユーザー ID・お客様の情報は表示しない（件数と有無のみ）。
-- =============================================================================
with checks(item, ok, detail) as (
  select '適用履歴が 6 本（1〜6 本目）で、7 本目は未適用',
         (select array_agg(version order by version) from supabase_migrations.schema_migrations)
           = array['20261110000000', '20261110010000', '20261110020000', '20261111000000', '20261112000000',
                   '20261113000000']::text[],
         coalesce((select string_agg(version, ', ' order by version) from supabase_migrations.schema_migrations), '(なし)')
  union all
  select '追加するテーブル owner_notification_batches がまだ存在しない',
         to_regclass('public.owner_notification_batches') is null,
         ''
  union all
  select '追加する関数がまだ存在しない（claim_owner_notification_batch・finish_owner_notification_batch。同名の関数もない）',
         not exists (select 1 from pg_proc
                      where proname in ('claim_owner_notification_batch', 'finish_owner_notification_batch')),
         ''
  union all
  select '追加するインデックス名がまだ存在しない',
         to_regclass('public.owner_notification_batches_date_idx') is null
         and to_regclass('public.owner_notification_batches_attempt_idx') is null
         and to_regclass('public.owner_notification_batches_open_idx') is null,
         ''
  union all
  select 'アドバイザリーロックのキー 7461801206180002 を他の関数が使っていない',
         not exists (select 1 from pg_proc where prosrc like '%7461801206180002%'),
         ''
  union all
  select 'public のテーブルが想定の 8 つだけ',
         (select array_agg(relname::text order by relname) from pg_class
           where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm', 'f'))
           = array['admin_users', 'ai_usage_reservations', 'broadcasts', 'conversations', 'faqs',
                   'line_webhook_events', 'menus', 'shop_settings'],
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
  -- 7 本目の関数が依存する既存の列・制約・権限（変更はしないが、前提として必要）
  select '依存：line_webhook_events の要通知・通知日時の列と制約・未通知用インデックスがある（2 本目）',
         (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'line_webhook_events'
             and column_name in ('needs_owner_notification', 'owner_notified_at', 'received_at', 'webhook_event_id')) = 4
         and exists (select 1 from pg_constraint
                      where conrelid = 'public.line_webhook_events'::regclass and conname = 'line_webhook_events_owner_notified_check')
         and to_regclass('public.line_webhook_events_owner_pending_idx') is not null,
         ''
  union all
  select '依存：conversations に line_event_id・needs_owner・owner_notified_at がある（1 本目）',
         (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'conversations'
             and column_name in ('line_event_id', 'needs_owner', 'owner_notified_at')) = 3,
         ''
  union all
  select '依存：service_role は line_webhook_events・conversations を参照・更新できる（3 本目）',
         -- カンマ区切りは「いずれか」の判定になるため、権限ごとに確認する
         has_table_privilege('service_role', 'public.line_webhook_events', 'SELECT')
         and has_table_privilege('service_role', 'public.line_webhook_events', 'UPDATE')
         and has_table_privilege('service_role', 'public.conversations', 'SELECT')
         and has_table_privilege('service_role', 'public.conversations', 'UPDATE'),
         ''
  union all
  -- 関数はロック後の状態を新しいスナップショットで読むため READ COMMITTED を前提にしている
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
  select '関数が使う gen_random_uuid()・make_interval() がある（PostgreSQL 13 以降の標準関数）',
         to_regprocedure('pg_catalog.gen_random_uuid()') is not null
         and exists (select 1 from pg_proc where proname = 'make_interval' and pronamespace = 'pg_catalog'::regnamespace),
         current_setting('server_version')
  union all
  select 'shop_settings：1 行・自動応答は OFF',
         (select count(*) from public.shop_settings) = 1
         and (select not bot_enabled from public.shop_settings where id = 1),
         ''
  union all
  select '参考：通知先（owner_line_user_id）の設定の有無（値は表示しない）',
         true,
         case when (select owner_line_user_id from public.shop_settings where id = 1) is null then '未設定（適用後も通知は送られない）'
              else '設定済み' end
  union all
  select '参考：適用後に最初の通知の対象になりうるイベント数（要通知・未通知・7 日以内）',
         true,
         (select count(*) from public.line_webhook_events
           where needs_owner_notification and owner_notified_at is null
             and received_at > now() - interval '7 days')::text
  union all
  select '参考：既存データの行数（conversations / line_webhook_events / ai_usage_reservations / faqs / menus）',
         true,
         (select count(*) from public.conversations)::text || ' / ' || (select count(*) from public.line_webhook_events)::text
           || ' / ' || (select count(*) from public.ai_usage_reservations)::text
           || ' / ' || (select count(*) from public.faqs)::text || ' / ' || (select count(*) from public.menus)::text
)
select case when ok then 'OK' else 'NG' end as result, item, detail
from checks
order by ok, item;
