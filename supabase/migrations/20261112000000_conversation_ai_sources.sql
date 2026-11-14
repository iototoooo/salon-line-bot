-- =============================================================================
-- conversations に AI 回答の根拠（FAQ・メニュー・店舗情報の項目）と判定理由を記録する列を追加する
--
-- 変更理由
--   AI 応答（WBS 2）で、どの登録情報を根拠に回答したかを後から追跡できるようにする
--   （誤回答の調査、FAQ の改善、オーナーの確認用）。
--
-- 方針
--   - 根拠の ID は配列で持ち、外部キーにはしない（FAQ・メニューを削除しても会話ログは残すため）
--   - 店舗情報の項目名は許可リストで制限する
--   - ai_reason は AI が付けた判定理由（オーナー確認用・短文）。個人情報を書かせない指示をプロンプトに含め、300 文字までに制限する
--   - 権限は既存のテーブル単位の付与（3 本目）で足りる。authenticated は参照のみ（更新可能な列は増やさない）
--   - 既存行は既定値（空配列・null）になる。既存のマイグレーションは変更しない
-- =============================================================================

alter table public.conversations
  -- 配列の要素に null を入れない（array_position(x, null) は null 要素がなければ null を返す）
  add column source_faq_ids uuid[] not null default '{}'
    constraint conversations_source_faq_ids_check check (
      cardinality(source_faq_ids) <= 20 and array_position(source_faq_ids, null) is null
    ),
  add column source_menu_ids uuid[] not null default '{}'
    constraint conversations_source_menu_ids_check check (
      cardinality(source_menu_ids) <= 20 and array_position(source_menu_ids, null) is null
    ),
  add column source_shop_fields text[] not null default '{}'
    constraint conversations_source_shop_fields_check check (
      cardinality(source_shop_fields) <= 10
      and array_position(source_shop_fields, null) is null
      and source_shop_fields <@ array[
        'shop_name', 'business_hours', 'regular_holidays', 'address',
        'phone', 'parking', 'reservation_guide', 'temporary_notice'
      ]::text[]
    ),
  add column ai_reason text
    constraint conversations_ai_reason_check check (ai_reason is null or char_length(ai_reason) <= 300);

comment on column public.conversations.source_faq_ids is 'AI 回答の根拠にした faqs.id（外部キーではない。FAQ 削除後も残る）';
comment on column public.conversations.source_menu_ids is 'AI 回答の根拠にした menus.id（外部キーではない。メニュー削除後も残る）';
comment on column public.conversations.source_shop_fields is 'AI 回答の根拠にした shop_settings の項目名';
comment on column public.conversations.ai_reason is 'AI の判定理由（回答不能・予約の理由など。オーナー確認用・300 文字まで）';
