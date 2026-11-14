-- =============================================================================
-- 適用後チェック（読み取り専用・SELECT 1 文のみ）
-- 対象：salon-line-bot（Project Ref: dnortggovlwgcdeoadbf）
--
-- 実行方法（どちらか）
--   CLI : npx supabase@3.1.0 db query --workdir <このリポジトリ> --remote=dnortggovlwgcdeoadbf --read-only -f scripts/supabase/verify.sql
--   画面: https://supabase.com/dashboard/project/dnortggovlwgcdeoadbf/sql/new に貼り付けて実行
--
-- 判定：全行 result = OK なら合格（NG が先頭に並ぶ）。
-- 権限は「足りない」だけでなく「付け過ぎ」も NG にする（anon・authenticated・service_role とも期待値と完全一致を確認）。
-- 同じ内容をローカルの PGlite でも検証している（tests/db/verify-sql.test.ts）。
-- =============================================================================
with
expected_tables(t, policies) as (values
  ('admin_users', 1), ('shop_settings', 2), ('faqs', 1), ('menus', 1),
  ('line_webhook_events', 0), ('conversations', 2), ('broadcasts', 4),
  ('ai_usage_reservations', 0), ('owner_notification_batches', 0)
),
tbl as (
  select e.t, e.policies, to_regclass('public.' || e.t) as oid,
         (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = e.t) as actual_policies
  from expected_tables e
),
-- サーバー（service_role）専用の関数
service_only_functions(sig) as (values
  ('public.claim_line_webhook_event(text,text,boolean,timestamptz,interval)'),
  ('public.begin_line_reply(text)'),
  ('public.record_line_reply_result(text,text)'),
  ('public.finish_line_webhook_event(text,text,text,boolean)'),
  ('public.mark_stalled_line_webhook_events(interval)'),
  ('public.start_broadcast_sending(uuid,integer,integer)'),
  ('public.reserve_ai_usage(text,text,integer,integer,integer)'),
  ('public.claim_owner_notification_batch(boolean,integer,integer,integer)'),
  ('public.finish_owner_notification_batch(uuid,text,text)'),
  ('public.run_retention_purge()'),
  ('private.purge_expired_data(interval,interval)')
),
fn as (
  select sig, to_regprocedure(sig) as oid from service_only_functions
),
-- authenticated（管理画面）に許可する操作。列単位の権限は has_column_privilege で個別に確認する
auth_expect(t, sel, ins, upd, del) as (values
  ('admin_users',         true,  false, false, false),
  ('shop_settings',       true,  false, false, false),
  ('faqs',                true,  true,  true,  true),
  ('menus',               true,  true,  true,  true),
  ('line_webhook_events', false, false, false, false),
  ('conversations',       true,  false, false, false),
  ('broadcasts',          true,  false, false, true),
  ('ai_usage_reservations', false, false, false, false),
  ('owner_notification_batches', false, false, false, false)
),
-- service_role（サーバー処理）に許可する操作。20261110020000_grant_service_role.sql と一致させる
service_expect(t, sel, ins, upd, del) as (values
  ('admin_users',         false, false, false, false),
  ('shop_settings',       true,  false, false, false),
  ('faqs',                true,  false, false, false),
  ('menus',               true,  false, false, false),
  ('line_webhook_events', true,  true,  true,  false),
  ('conversations',       true,  true,  true,  false),
  ('broadcasts',          true,  false, true,  false),
  -- 6 本目（20261113000000_ai_usage_limits.sql）：利用枠の確保（追加）と古い記録の削除のみ
  ('ai_usage_reservations', true, true,  false, true),
  -- 7 本目（20261114000000_owner_notifications.sql）：まとめの確保・結果の記録・30 日より古い記録の削除
  ('owner_notification_batches', true, true, true, true)
),
column_expect(t, col, priv, expected) as (values
  ('shop_settings', 'bot_enabled',  'UPDATE', true),
  ('shop_settings', 'id',           'UPDATE', false),
  ('shop_settings', 'updated_at',   'UPDATE', false),
  ('conversations', 'resolved_at',  'UPDATE', true),
  ('conversations', 'resolved_by',  'UPDATE', true),
  ('conversations', 'needs_owner',  'UPDATE', false),
  ('conversations', 'bot_reply',    'UPDATE', false),
  ('broadcasts',    'body',         'INSERT', true),
  ('broadcasts',    'body',         'UPDATE', true),
  ('broadcasts',    'status',       'INSERT', false),
  ('broadcasts',    'status',       'UPDATE', false),
  ('broadcasts',    'retry_key',    'UPDATE', false),
  ('line_webhook_events', 'status', 'SELECT', false)
),
expected_triggers(t, name) as (values
  ('shop_settings', 'shop_settings_set_updated_at'),
  ('faqs',          'faqs_set_updated_at'),
  ('menus',         'menus_set_updated_at'),
  ('broadcasts',    'broadcasts_guard')
),
expected_indexes(name) as (values
  ('broadcasts_one_sending_idx'), ('conversations_unresolved_idx'),
  ('line_webhook_events_processing_idx'), ('line_webhook_events_owner_pending_idx')
),
expected_constraints(name) as (values
  ('line_webhook_events_status_check'), ('line_webhook_events_processed_at_check'),
  ('line_webhook_events_reply_status_check'), ('line_webhook_events_reply_attempted_check'),
  ('line_webhook_events_last_error_check'), ('line_webhook_events_owner_notified_check')
),
expected_columns(name) as (values
  ('event_timestamp'), ('processing_started_at'), ('reply_deadline_at'), ('reply_status'),
  ('reply_attempted_at'), ('last_error'), ('needs_owner_notification'), ('owner_notified_at')
),
checks(category, item, ok, detail) as (
  -- 1. テーブル・RLS・ポリシー
  select '1 テーブル', t, oid is not null, '' from tbl
  union all
  select '2 RLS 有効', t, coalesce((select relrowsecurity from pg_class where oid = tbl.oid), false), '' from tbl
  union all
  select '3 ポリシー数', t, actual_policies = policies,
         format('期待 %s / 実際 %s', policies, actual_policies) from tbl

  -- 2. テーブル権限
  union all
  select '4 anon は全テーブルに権限なし', t,
         oid is not null
         and not has_table_privilege('anon', oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
         and not has_any_column_privilege('anon', oid, 'SELECT, INSERT, UPDATE, REFERENCES'),
         '' from tbl
  union all
  select '5 service_role はサーバー処理に必要な操作だけ可能', s.t,
         tbl.oid is not null
         and has_table_privilege('service_role', tbl.oid, 'SELECT') = s.sel
         and has_table_privilege('service_role', tbl.oid, 'INSERT') = s.ins
         and has_table_privilege('service_role', tbl.oid, 'UPDATE') = s.upd
         and has_table_privilege('service_role', tbl.oid, 'DELETE') = s.del
         and not has_table_privilege('service_role', tbl.oid, 'TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
         format('期待 select=%s insert=%s update=%s delete=%s（TRUNCATE 等は不可）。20261110020000_grant_service_role.sql 参照',
                s.sel, s.ins, s.upd, s.del)
    from service_expect s join tbl on tbl.t = s.t
  union all
  select '6 authenticated のテーブル単位の権限', a.t,
         tbl.oid is not null
         and has_table_privilege('authenticated', tbl.oid, 'SELECT') = a.sel
         and has_table_privilege('authenticated', tbl.oid, 'INSERT') = a.ins
         and has_table_privilege('authenticated', tbl.oid, 'UPDATE') = a.upd
         and has_table_privilege('authenticated', tbl.oid, 'DELETE') = a.del
         and not has_table_privilege('authenticated', tbl.oid, 'TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'),
         format('期待 select=%s insert=%s update=%s delete=%s', a.sel, a.ins, a.upd, a.del)
    from auth_expect a join tbl on tbl.t = a.t
  union all
  select '7 authenticated の列単位の権限', c.t || '.' || c.col || ' ' || c.priv,
         to_regclass('public.' || c.t) is not null
         and has_column_privilege('authenticated', to_regclass('public.' || c.t), c.col, c.priv) = c.expected,
         format('期待 %s', c.expected)
    from column_expect c

  -- 3. 関数
  union all
  select '8 関数がある', sig, oid is not null, '' from fn
  union all
  select '9 関数はサーバー専用（anon・authenticated は実行不可、service_role は可）', sig,
         oid is not null
         and not has_function_privilege('anon', oid, 'EXECUTE')
         and not has_function_privilege('authenticated', oid, 'EXECUTE')
         and has_function_privilege('service_role', oid, 'EXECUTE'),
         '' from fn
  union all
  select '9 関数はサーバー専用（anon・authenticated は実行不可、service_role は可）', 'private.is_admin()',
         to_regprocedure('private.is_admin()') is not null
         and not has_function_privilege('anon', to_regprocedure('private.is_admin()'), 'EXECUTE')
         and has_function_privilege('authenticated', to_regprocedure('private.is_admin()'), 'EXECUTE'),
         'is_admin だけは RLS 判定のため authenticated に実行を許可する'
  union all
  select '10 関数の search_path が固定されている', n.nspname || '.' || p.proname,
         exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%'),
         case when p.prosecdef then 'security definer' else 'security invoker' end
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
      or (n.nspname = 'public' and p.oid in (select oid from fn where oid is not null))

  -- 4. スキーマ
  union all
  select '11 private スキーマ', 'anon は使用不可・authenticated は使用可',
         to_regnamespace('private') is not null
         and not has_schema_privilege('anon', 'private', 'USAGE')
         and has_schema_privilege('authenticated', 'private', 'USAGE'),
         'Data API の公開スキーマに private を含めないこと（画面で確認）'

  -- 5. トリガー・インデックス・制約・列
  union all
  select '12 トリガー', e.t || '.' || e.name,
         exists (select 1 from pg_trigger tg
                  where tg.tgrelid = to_regclass('public.' || e.t) and tg.tgname = e.name and not tg.tgisinternal),
         '' from expected_triggers e
  union all
  select '13 インデックス', e.name, to_regclass('public.' || e.name) is not null, '' from expected_indexes e
  union all
  select '14 line_webhook_events の制約（2 本目のマイグレーション）', e.name,
         exists (select 1 from pg_constraint c
                  where c.conrelid = to_regclass('public.line_webhook_events') and c.conname = e.name),
         '' from expected_constraints e
  union all
  select '14 line_webhook_events の制約（2 本目のマイグレーション）', '旧制約 line_webhook_events_check が削除済み',
         not exists (select 1 from pg_constraint c
                      where c.conrelid = to_regclass('public.line_webhook_events')
                        and c.conname = 'line_webhook_events_check'),
         ''
  union all
  select '15 line_webhook_events の追加列', e.name,
         exists (select 1 from information_schema.columns ic
                  where ic.table_schema = 'public' and ic.table_name = 'line_webhook_events'
                    and ic.column_name = e.name),
         '' from expected_columns e
  union all
  select '15 line_webhook_events の追加列', 'reply_status に simulated（dry-run）を許可（4 本目のマイグレーション）',
         exists (select 1 from pg_constraint c
                  where c.conrelid = to_regclass('public.line_webhook_events')
                    and c.conname = 'line_webhook_events_reply_status_check'
                    and pg_get_constraintdef(c.oid) like '%simulated%')
         and coalesce((select prosrc like '%simulated%'
                         from pg_proc where oid = to_regprocedure('public.record_line_reply_result(text,text)')), false),
         '20261111000000_reply_status_simulated.sql。未適用だと dry-run の返信結果を記録できない'
  union all
  select '15 conversations の追加列', 'conversations に AI 回答の根拠の列（5 本目のマイグレーション）',
         (select count(*) from information_schema.columns ic
           where ic.table_schema = 'public' and ic.table_name = 'conversations'
             and ic.column_name in ('source_faq_ids', 'source_menu_ids', 'source_shop_fields', 'ai_reason')) = 4
         and (select count(*) from pg_constraint c
               where c.conrelid = to_regclass('public.conversations')
                 and c.conname in ('conversations_source_faq_ids_check', 'conversations_source_menu_ids_check',
                                   'conversations_source_shop_fields_check', 'conversations_ai_reason_check')) = 4,
         '20261112000000_conversation_ai_sources.sql。未適用のまま LINE_RESPONDER=ai にすると会話ログを保存できない'
  union all
  select '15 ai_usage_reservations（利用回数制限）', 'LINE ユーザー ID は保存せずハッシュ値のみ（6 本目のマイグレーション）',
         (select count(*) from information_schema.columns ic
           where ic.table_schema = 'public' and ic.table_name = 'ai_usage_reservations'
             and ic.column_name in ('webhook_event_id', 'user_key', 'jst_date', 'reserved_at')) = 4
         and not exists (select 1 from information_schema.columns ic
                          where ic.table_schema = 'public' and ic.table_name = 'ai_usage_reservations'
                            and ic.column_name not in ('webhook_event_id', 'user_key', 'jst_date', 'reserved_at')),
         '20261113000000_ai_usage_limits.sql。未適用のまま LINE_RESPONDER=ai にすると AI を呼ばない（利用枠を確認できないため）'
  union all
  select '15 ai_usage_reservations（利用回数制限）', '利用枠の確保は同じイベントで 1 回だけ（主キー）・ロックで直列化',
         exists (select 1 from pg_constraint c
                  where c.conrelid = to_regclass('public.ai_usage_reservations') and c.contype = 'p')
         and coalesce((select prosrc like '%pg_advisory_xact_lock%'
                         from pg_proc where oid = to_regprocedure('public.reserve_ai_usage(text,text,integer,integer,integer)')), false),
         '同時に届いた Webhook でも上限を超えないこと'
  union all
  select '15 owner_notification_batches（オーナー通知）', 'ユーザー ID・本文を保存しない列構成（7 本目のマイグレーション）',
         (select count(*) from information_schema.columns ic
           where ic.table_schema = 'public' and ic.table_name = 'owner_notification_batches') = 11
         and not exists (select 1 from information_schema.columns ic
                          where ic.table_schema = 'public' and ic.table_name = 'owner_notification_batches'
                            and ic.column_name not in ('id', 'retry_key', 'event_ids', 'urgent', 'status', 'attempts',
                                                       'jst_date', 'created_at', 'last_attempt_at', 'finished_at', 'last_error')),
         '20261114000000_owner_notifications.sql。未適用のまま LINE_REPLY_MODE=live にすると通知を確保できず、送られない（返信には影響しない）'
  union all
  select '15 owner_notification_batches（オーナー通知）', '再送キーは一意・まとめの確保はロックで直列化',
         exists (select 1 from pg_constraint c
                  where c.conrelid = to_regclass('public.owner_notification_batches') and c.contype = 'u')
         and coalesce((select prosrc like '%pg_advisory_xact_lock%'
                         from pg_proc where oid = to_regprocedure('public.claim_owner_notification_batch(boolean,integer,integer,integer)')), false),
         '同時に呼ばれても 1 通だけ・成否不明の再送でも LINE 側で二重に届かないこと'
  union all
  select '15 保持期間の削除（定期実行）', '削除の入口は引数なし・保持期間固定・重複実行は busy（8 本目のマイグレーション）',
         coalesce((select prosrc like '%pg_try_advisory_xact_lock%'
                          and prosrc like '%interval ''90 days'', interval ''7 days''%'
                          and not prosecdef
                     from pg_proc where oid = to_regprocedure('public.run_retention_purge()')), false),
         '20261115000000_retention_purge.sql。未適用のまま /api/cron/retention を有効にすると毎日 500 になり、期限切れのデータが残る'

  -- 6. 初期データ
  union all
  select '16 初期データ', 'shop_settings は 1 行・自動応答は OFF',
         (select count(*) from public.shop_settings) = 1
         and (select not bot_enabled from public.shop_settings where id = 1),
         '初期データ登録が終わるまで bot_enabled = false のままにする'
)
select category, item, case when ok then 'OK' else 'NG' end as result, detail
from checks
order by ok, split_part(category, ' ', 1)::int, item;
