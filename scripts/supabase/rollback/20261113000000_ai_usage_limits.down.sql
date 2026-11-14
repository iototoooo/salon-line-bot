-- =============================================================================
-- 【手動用・通常は使わない】6 本目（20261113000000_ai_usage_limits.sql）の取り消し
--
-- 使う場面：6 本目の適用後に問題が見つかり、オーナーが取り消しを承認した場合のみ。
-- 実行方法：Supabase SQL Editor で、URL の Ref が dnortggovlwgcdeoadbf であることを確認してから実行する。
--
-- 注意
--   - 事前に管理画面（または承認を得た手順）で shop_settings.bot_enabled を false にする（AI を呼ばず定型文のみになる）。
--     本番（VERCEL_ENV=production）では LINE_RESPONDER=echo は使えない（起動時エラー）ため、echo への切り替えでは止めない。
--     bot_enabled を戻さずに ai のまま取り消した場合も、利用枠を確認できず AI は呼ばれない（すべて定型文）
--   - 利用枠の記録（最大 2 日分・ハッシュ値のみ）は失われる
--   - 適用履歴（supabase_migrations.schema_migrations）は変更しない（扱いは別途相談）
-- =============================================================================

begin;

drop function if exists public.reserve_ai_usage(text, text, integer, integer, integer);
drop table if exists public.ai_usage_reservations;

-- 確認：どちらも残っていないこと（両方 null であること）
select to_regclass('public.ai_usage_reservations') as table_left,
       to_regprocedure('public.reserve_ai_usage(text,text,integer,integer,integer)') as function_left;

commit;
