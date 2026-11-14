-- =============================================================================
-- 【手動用・通常は使わない】学習用サンプルデータ（sample-salon.sql）の取り消し
--
-- 使う場面：サンプルを登録した後に、登録前の状態へ戻すとき（オーナーの承認後のみ）。
-- 実行方法：Supabase の SQL Editor で、URL の Ref が dnortggovlwgcdeoadbf であることを確認してから実行する。
--
-- 戻すもの（サンプルで入れたものだけ）
--   - faqs   ：サンプルの質問文と完全に一致する 12 件だけを削除する
--   - menus  ：サンプルのメニュー名と完全に一致する 10 件だけを削除する
--   - shop_settings：店名がサンプルのままのときだけ、店舗情報の 8 項目を空に戻す
--     （2026-11-14 の登録前は 8 項目とも空だったことを読み取り専用で確認済み）
-- 変えないもの：自動応答（bot_enabled）・通知先・定型文・会話ログ・配信、サンプル以外の FAQ・メニュー
--
-- 安全のための確認（どれかに当てはまると、何も変えずにエラーで止まる）
--   - 自動応答が ON（先に OFF にする。OFF のまま戻さないと、空の登録情報で応答することになる）
--   - サンプルの FAQ・メニューの件数が合わない（手で編集・追加された可能性があるため、管理画面で確認する）
-- =============================================================================

begin;

do $$
declare
  v_faqs int;
  v_menus int;
begin
  if exists (select 1 from public.shop_settings where id = 1 and bot_enabled) then
    raise exception '自動応答が ON です。先に OFF にしてから取り消してください';
  end if;
  select count(*) into v_faqs from public.faqs where question in (
    '営業時間を教えてください', '定休日はいつですか', '予約の方法を教えてください',
    '予約のキャンセルや日時の変更はどうすればいいですか', '支払い方法は何が使えますか',
    'カラーの料金は髪の長さで変わりますか', 'カットにはどのくらい時間がかかりますか',
    '子どものカットはできますか', '白髪染めはできますか', '駐車場はありますか',
    'お店の場所を教えてください', 'なりたい髪型の写真を見せてもいいですか');
  select count(*) into v_menus from public.menus where name in (
    'カット', '前髪カット', 'キッズカット（小学生まで）', 'カラー', 'リタッチカラー',
    'パーマ', 'トリートメント', 'ヘッドスパ', 'カット＋カラー', 'カット＋パーマ');
  if v_faqs <> 12 or v_menus <> 10 then
    raise exception 'サンプルの件数が合いません（FAQ % 件・メニュー % 件）。手で変更された可能性があるため中止します', v_faqs, v_menus;
  end if;
end;
$$;

delete from public.faqs where question in (
  '営業時間を教えてください', '定休日はいつですか', '予約の方法を教えてください',
  '予約のキャンセルや日時の変更はどうすればいいですか', '支払い方法は何が使えますか',
  'カラーの料金は髪の長さで変わりますか', 'カットにはどのくらい時間がかかりますか',
  '子どものカットはできますか', '白髪染めはできますか', '駐車場はありますか',
  'お店の場所を教えてください', 'なりたい髪型の写真を見せてもいいですか');

delete from public.menus where name in (
  'カット', '前髪カット', 'キッズカット（小学生まで）', 'カラー', 'リタッチカラー',
  'パーマ', 'トリートメント', 'ヘッドスパ', 'カット＋カラー', 'カット＋パーマ');

update public.shop_settings set
  shop_name = '', business_hours = '', regular_holidays = '', address = '',
  phone = '', parking = '', reservation_guide = '', temporary_notice = ''
where id = 1 and shop_name = 'ヘアサロン こもれびの森（学習用の架空店舗）';

-- 確認：FAQ・メニューの件数、店名が空か、自動応答は OFF のままか
select (select count(*) from public.faqs) as faqs,
       (select count(*) from public.menus) as menus,
       (select shop_name = '' from public.shop_settings where id = 1) as shop_cleared,
       (select bot_enabled from public.shop_settings where id = 1) as bot_enabled;

commit;
