-- =============================================================================
-- 【手動用・通常は使わない】8 本目（20261115000000_retention_purge.sql）の取り消し
--
-- 使う場面：8 本目の適用後に問題が見つかり、オーナーが取り消しを承認した場合のみ。
-- 実行方法：Supabase SQL Editor で、URL の Ref が dnortggovlwgcdeoadbf であることを確認してから実行する。
--
-- 注意
--   - 先に vercel.json の schedules「retention」を外してデプロイする（残っていると毎日 500 になる）
--   - 取り消し後は定期削除が行われない（会話ログ・Webhook イベントが保持期間を過ぎても残る）
--   - 削除済みのデータは戻らない
--   - private.purge_expired_data・テーブル・権限は変更しない
--   - 適用履歴（supabase_migrations.schema_migrations）は変更しない（扱いは別途相談）
-- =============================================================================

begin;

drop function if exists public.run_retention_purge();

-- 確認：残っていないこと（null であること）
select to_regprocedure('public.run_retention_purge()') as purge_left;

commit;
