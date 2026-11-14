-- =============================================================================
-- デプロイ前後の比較用スナップショット（読み取り専用・SELECT 1 文のみ）
-- 対象：salon-line-bot（Project Ref: dnortggovlwgcdeoadbf）
--
-- 使い方：デプロイの直前と直後に実行し、結果が同じであることを確認する（docs/deployment.md 10・11 章）。
--   sb db query --remote=dnortggovlwgcdeoadbf --read-only -f scripts/supabase/deploy-snapshot.sql
-- 表示するのは件数・最終更新日時・ON/OFF だけ（本文・LINE ユーザー ID・メールアドレスは表示しない）。
-- 管理画面へのログインでは Supabase Auth のセッション（auth スキーマ）だけが記録され、ここに並ぶ public のテーブルは変わらない。
-- =============================================================================
select item, value
from (values
  (1,  'shop_settings：自動応答（bot_enabled）', (select bot_enabled::text from public.shop_settings where id = 1)),
  (2,  'shop_settings：通知先が登録済みか',      (select (owner_line_user_id is not null)::text from public.shop_settings where id = 1)),
  (3,  'shop_settings：最終更新',                (select updated_at::text from public.shop_settings where id = 1)),
  (4,  'faqs：件数／最終更新',                   (select count(*) || ' / ' || coalesce(max(updated_at)::text, '-') from public.faqs)),
  (5,  'menus：件数／最終更新',                  (select count(*) || ' / ' || coalesce(max(updated_at)::text, '-') from public.menus)),
  (6,  'broadcasts：件数／最終更新',             (select count(*) || ' / ' || coalesce(max(updated_at)::text, '-') from public.broadcasts)),
  (7,  'admin_users：件数',                      (select count(*)::text from public.admin_users)),
  (8,  'conversations：件数／最新',              (select count(*) || ' / ' || coalesce(max(created_at)::text, '-') from public.conversations)),
  (9,  'conversations：対応済みの件数',          (select count(*)::text from public.conversations where resolved_at is not null)),
  (10, 'line_webhook_events：件数／最新の受信',  (select count(*) || ' / ' || coalesce(max(received_at)::text, '-') from public.line_webhook_events)),
  (11, 'ai_usage_reservations：件数',            (select count(*)::text from public.ai_usage_reservations)),
  (12, 'owner_notification_batches：件数／最新', (select count(*) || ' / ' || coalesce(max(created_at)::text, '-') from public.owner_notification_batches)),
  (13, 'line_webhook_events：要通知・未通知の件数', (select count(*)::text from public.line_webhook_events where needs_owner_notification and owner_notified_at is null))
) as t(n, item, value)
order by n;
