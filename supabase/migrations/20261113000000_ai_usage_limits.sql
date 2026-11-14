-- =============================================================================
-- Claude API の利用回数制限（6 本目）
--
-- 目的
--   大量の LINE メッセージや同時リクエストで、Claude API の呼び出し回数が想定外に増えることを防ぐ。
--   回数の上限であり、請求金額の上限を保証するものではない（1 回あたりのトークン数は質問・登録情報で変わる）。
--
-- 仕組み
--   AI を呼び出す直前に public.reserve_ai_usage を呼び、上限内なら 1 回分の利用枠を確保（記録）する。
--   確認と確保は 1 つの関数の中で、トランザクション単位のアドバイザリーロックを取ってから行うため、
--   複数の Webhook が同時に届いても順番に判定され、上限を超えて確保されることはない。
--
-- 上限（呼び出し側から渡す。既定値は初期設定の値）
--   同一 LINE ユーザー：直近 10 分間に 5 回 / 日本時間の 1 日に 30 回
--   店舗全体          ：日本時間の 1 日に 300 回
--
-- 個人情報
--   LINE ユーザー ID はそのまま保存せず、SHA-256 のハッシュ値（16 進）だけを保存する。
--   （conversations には ID が残るため突き合わせは可能。このテーブル単体で ID を持たないための措置）
--   2 日より古い記録は、関数の呼び出し時に削除する（判定には当日分と直近 10 分しか使わない）。
--
-- 既知の制限
--   - 店舗全体の上限は、複数のアカウントからの連投で使い切られうる（その日は全員が定型文になる。費用は増えない）
--   - 日付・10 分の判定はトランザクション開始時刻（now()）基準。0 時をまたいでロック待ちした場合、数秒の誤差がありうる
--
-- 権限
--   テーブル・関数とも service_role 専用（anon・authenticated には付与しない）。RLS は有効・ポリシーなし。
-- =============================================================================

create table public.ai_usage_reservations (
  -- 同じイベントで二重に利用枠を消費しない
  webhook_event_id  text primary key check (char_length(webhook_event_id) between 1 and 100),
  user_key          text not null check (user_key ~ '^[0-9a-f]{64}$'),
  -- 日本時間の日付（日次の上限の集計単位）
  jst_date          date not null,
  reserved_at       timestamptz not null default now()
);

comment on table public.ai_usage_reservations is
  'Claude API の利用枠の確保記録（回数制限用）。LINE ユーザー ID はハッシュ値のみ。2 日で削除';
comment on column public.ai_usage_reservations.user_key is 'LINE ユーザー ID の SHA-256（16 進）。元の ID は保存しない';

create index ai_usage_reservations_date_idx on public.ai_usage_reservations (jst_date);
create index ai_usage_reservations_user_idx on public.ai_usage_reservations (user_key, reserved_at desc);

alter table public.ai_usage_reservations enable row level security;
-- ポリシーは作らない（authenticated・anon からは一切参照できない。service_role は RLS をバイパスする）

revoke all on public.ai_usage_reservations from public, anon, authenticated, service_role;
grant select, insert, delete on public.ai_usage_reservations to service_role;

-- -----------------------------------------------------------------------------
-- 利用枠の確認と確保
--   戻り値：
--     'reserved'          確保した（AI を呼んでよい）
--     'duplicate'         同じイベントで確保済み（二重に呼ばない）
--     'shop_daily_limit'  店舗全体の 1 日の上限に到達
--     'user_daily_limit'  同一ユーザーの 1 日の上限に到達
--     'user_burst_limit'  同一ユーザーの 10 分間の上限に到達
--   'reserved' 以外では AI を呼ばないこと。引数が不正な場合は例外（呼び出し側は AI を呼ばない）。
-- -----------------------------------------------------------------------------
create or replace function public.reserve_ai_usage(
  p_webhook_event_id text,
  p_line_user_id text,
  p_user_burst_limit integer default 5,
  p_user_daily_limit integer default 30,
  p_shop_daily_limit integer default 300
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_user_key text;
begin
  if p_webhook_event_id is null or char_length(p_webhook_event_id) not between 1 and 100 then
    raise exception 'invalid webhook event id';
  end if;
  if p_line_user_id is null or p_line_user_id !~ '^U[0-9a-f]{32}$' then
    raise exception 'invalid line user id';
  end if;
  -- 上限値の最大値も DB 側で制限する（呼び出し側の設定ミスで実質無制限にならないように）
  if p_user_burst_limit is null or p_user_burst_limit not between 1 and 20
     or p_user_daily_limit is null or p_user_daily_limit not between 1 and 100
     or p_shop_daily_limit is null or p_shop_daily_limit not between 1 and 1000 then
    raise exception 'invalid usage limit';
  end if;
  -- ロック取得後の件数をトランザクション開始時より新しい状態で数えるため、READ COMMITTED を前提にする
  -- （REPEATABLE READ 以上ではロック前のスナップショットで数え、同時実行で上限を超えうる）
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'reserve_ai_usage requires read committed isolation';
  end if;

  -- 確認と確保をまとめて直列化する（同時に届いた Webhook でも上限を超えない）。トランザクション終了で解放
  perform pg_advisory_xact_lock(7461801206180001);

  -- 判定に使わない古い記録を削除する（当日分と直近 10 分だけあればよい）
  delete from public.ai_usage_reservations where reserved_at < now() - interval '2 days';

  if exists (select 1 from public.ai_usage_reservations where webhook_event_id = p_webhook_event_id) then
    return 'duplicate';
  end if;

  v_user_key := encode(sha256(convert_to(p_line_user_id, 'UTF8')), 'hex');

  if (select count(*) from public.ai_usage_reservations where jst_date = v_today) >= p_shop_daily_limit then
    return 'shop_daily_limit';
  end if;
  if (select count(*) from public.ai_usage_reservations
       where user_key = v_user_key and jst_date = v_today) >= p_user_daily_limit then
    return 'user_daily_limit';
  end if;
  if (select count(*) from public.ai_usage_reservations
       where user_key = v_user_key and reserved_at > now() - interval '10 minutes') >= p_user_burst_limit then
    return 'user_burst_limit';
  end if;

  insert into public.ai_usage_reservations (webhook_event_id, user_key, jst_date)
  values (p_webhook_event_id, v_user_key, v_today);
  return 'reserved';
end;
$$;

revoke all on function public.reserve_ai_usage(text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_ai_usage(text, text, integer, integer, integer) to service_role;
