-- =============================================================================
-- 登録情報（店舗情報・FAQ・メニュー）の指紋（読み取り専用・SELECT 1 文のみ）
-- 対象：salon-line-bot（Project Ref: dnortggovlwgcdeoadbf）
--
-- 使い方：管理画面で編集して元に戻すテスト（AC-22 など）の前後に実行し、3 行の指紋と件数が同じなら
--         内容が完全に元どおり（文言・分類・料金・補足・所要時間・公開・並び順まで同じ）と判断する。
--   sb db query --remote=dnortggovlwgcdeoadbf --read-only -f scripts/supabase/content-fingerprint.sql
-- ID・作成日時・更新日時は含めない（削除して作り直すと変わるため）。本文そのものは表示しない。
-- 自動応答（bot_enabled）・通知先・定型文は含めない（別途 deploy-snapshot.sql で確認する）。
-- =============================================================================
select item, n, fingerprint
from (
  select 1 as ord, '店舗情報（8 項目）' as item, '1' as n,
         md5(concat_ws('|', shop_name, business_hours, regular_holidays, address, phone, parking, reservation_guide, temporary_notice)) as fingerprint
    from public.shop_settings where id = 1
  union all
  select 2, 'FAQ', count(*)::text,
         md5(coalesce(string_agg(concat_ws('|', question, answer, category, is_published::text, sort_order::text), '#' order by sort_order, question, answer), ''))
    from public.faqs
  union all
  select 3, 'メニュー', count(*)::text,
         md5(coalesce(string_agg(concat_ws('|', name, category, price::text, price_note, coalesce(duration_min::text, '-'), description, is_published::text, sort_order::text), '#' order by sort_order, name, price), ''))
    from public.menus
) t
order by ord;
