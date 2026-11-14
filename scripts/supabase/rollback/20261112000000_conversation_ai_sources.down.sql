-- =============================================================================
-- 【手動用・通常は使わない】5 本目（20261112000000_conversation_ai_sources.sql）の取り消し
--
-- 使う場面：5 本目の適用後に問題が見つかり、オーナーが取り消しを承認した場合のみ。
-- 実行方法：Supabase SQL Editor で、URL の Ref が dnortggovlwgcdeoadbf であることを確認してから実行する。
--
-- 注意
--   - 追加した 4 列のデータ（AI 回答の根拠・判定理由）は失われる。会話ログのほかの列は残る
--   - 事前に LINE_RESPONDER を echo に戻す（ai のままだと会話ログの保存が失敗し続ける）
--   - 適用履歴（supabase_migrations.schema_migrations）は変更しない。
--     履歴の扱い（migration repair 等）は別途相談する（docs/supabase-setup.md「使ってはいけないコマンド」）
--   - db push が失敗した場合は、まず verify.sql（読み取り専用）と migration list で列・履歴の有無を確認する。
--     列の追加は 1 つの ALTER TABLE 文で行うため、4 列のうち一部だけが追加された状態にはならない
-- =============================================================================

begin;

alter table public.conversations
  drop column if exists source_faq_ids,
  drop column if exists source_menu_ids,
  drop column if exists source_shop_fields,
  drop column if exists ai_reason;

-- 確認：4 列が残っていないこと（0 であること）
select count(*) as remaining_columns
from information_schema.columns
where table_schema = 'public' and table_name = 'conversations'
  and column_name in ('source_faq_ids', 'source_menu_ids', 'source_shop_fields', 'ai_reason');

commit;
