-- =============================================================================
-- 【手動用・通常は使わない】7 本目（20261114000000_owner_notifications.sql）の取り消し
--
-- 使う場面：7 本目の適用後に問題が見つかり、オーナーが取り消しを承認した場合のみ。
-- 実行方法：Supabase SQL Editor で、URL の Ref が dnortggovlwgcdeoadbf であることを確認してから実行する。
--
-- 注意
--   - 取り消し後は通知のまとめを確保できないため、オーナー通知は送られない（お客様への返信には影響しない）。
--     要対応の記録（line_webhook_events.needs_owner_notification・conversations.needs_owner）はそのまま残る
--   - 送信記録（最大 30 日分・イベント ID とコードのみ）は失われる
--   - line_webhook_events・conversations の owner_notified_at（通知済みの記録）は変更しない
--   - 適用履歴（supabase_migrations.schema_migrations）は変更しない（扱いは別途相談）
-- =============================================================================

begin;

drop function if exists public.claim_owner_notification_batch(boolean, integer, integer, integer);
drop function if exists public.finish_owner_notification_batch(uuid, text, text);
drop table if exists public.owner_notification_batches;

-- 確認：すべて残っていないこと（3 つとも null であること）
select to_regclass('public.owner_notification_batches') as table_left,
       to_regprocedure('public.claim_owner_notification_batch(boolean,integer,integer,integer)') as claim_left,
       to_regprocedure('public.finish_owner_notification_batch(uuid,text,text)') as finish_left;

commit;
