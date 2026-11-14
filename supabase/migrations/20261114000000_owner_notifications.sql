-- =============================================================================
-- オーナー通知（7 本目・WBS 2.5）
--
-- 目的
--   AI が回答できなかった質問・テキスト以外の受信・AI 処理エラー・返信失敗・処理の停止などを、
--   オーナー個人の LINE へ push で知らせる（宛先は shop_settings.owner_line_user_id のみ）。
--
-- 通知の対象（既存の列をそのまま使う。新しい「通知キュー」は作らない）
--   line_webhook_events.needs_owner_notification = true かつ owner_notified_at が null のイベント。
--   AI 応答で要オーナー対応になったもの、返信の失敗、処理の停止（abandoned）はすべてここに記録される。
--   詳細（受信日時・状態・質問の先頭部分）は送信時に conversations から取得する（このテーブルに本文は持たない）。
--
-- 送信回数の制限（呼び出し側から渡す。既定値は初期設定の値）
--   - まとめ送信：未通知のイベントをまとめて 1 通にする（1 通に含めるのは最大 200 件。新しい順）
--   - 送信間隔  ：前回の送信（試行）から 10 分以内は送らない（その間の分は次の 1 通にまとまる）
--   - 1 日の上限：日本時間の 1 日に 5 通まで（失敗した試行も数える）。超えた分は翌日の 1 通にまとまる
--   - 例外      ：店舗全体の AI 利用上限に達したときの通知（urgent）は、1 日 1 回だけ間隔・上限を無視して送る
--
-- 重複送信の防止
--   - 確認と確保はアドバイザリーロックで直列化する（同時に呼ばれても 1 通だけ）
--   - 送信中・成否不明のまとめに含まれるイベントは、別のまとめに入れない
--   - LINE の X-Line-Retry-Key に retry_key を使う。成否不明（5xx・タイムアウト）のまとめは同じキーで再送するため、
--     LINE が受理済みなら 409 となり二重に届かない（キーの有効期間は最初の要求から 24 時間：LINE 公式ドキュメント）
--   - 再送は 3 回まで・作成から 23 時間以内。超えたら打ち切り、対象のイベントは次のまとめに含める
--     （届いていた場合はオーナーに同じ内容が 2 回届くことがある。通知の取りこぼしより重複を許容する）
--
-- 個人情報
--   このテーブルには LINE ユーザー ID・オーナーの ID・本文を保存しない（イベント ID とコードのみ）。
--   30 日より古い記録は、確保の呼び出し時に削除する。
--
-- 権限
--   テーブル・関数とも service_role 専用（anon・authenticated には付与しない）。RLS は有効・ポリシーなし。
--   既存のテーブル・関数・権限は変更しない（line_webhook_events・conversations の owner_notified_at の更新には
--   3 本目で service_role に付与済みの UPDATE を使う）。
-- =============================================================================

create table public.owner_notification_batches (
  id               uuid primary key default gen_random_uuid(),
  -- LINE の X-Line-Retry-Key（成否不明の再送でも同じ値を使う）
  retry_key        uuid not null unique default gen_random_uuid(),
  -- このまとめに含めた line_webhook_events.webhook_event_id（新しい順）
  event_ids        text[] not null check (cardinality(event_ids) between 1 and 200),
  -- 店舗全体の AI 利用上限の通知（1 日 1 回だけ間隔・上限の対象外）
  urgent           boolean not null default false,
  status           text not null default 'sending'
    check (status in ('sending', 'sent', 'failed', 'unknown', 'abandoned')),
  attempts         integer not null default 1 check (attempts between 1 and 10),
  -- 日本時間の作成日（1 日の上限の集計単位）
  jst_date         date not null,
  created_at       timestamptz not null default now(),
  last_attempt_at  timestamptz not null default now(),
  finished_at      timestamptz,
  -- 個人情報を含まないコードのみ
  last_error       text check (last_error is null or last_error ~ '^[a-z0-9_:]{1,100}$'),
  -- 送信中・成否不明（再送待ち）のときだけ未完了
  check ((status in ('sending', 'unknown')) = (finished_at is null))
);

comment on table public.owner_notification_batches is
  'オーナー通知（LINE push）のまとめ送信の記録。ユーザー ID・本文は保存しない。30 日で削除';
comment on column public.owner_notification_batches.status is
  'sending: 送信中 / sent: LINE が受理 / failed: LINE が拒否（対象は次のまとめへ） / unknown: 成否不明（同じキーで再送） / abandoned: 再送の打ち切り（対象は次のまとめへ）';

create index owner_notification_batches_date_idx on public.owner_notification_batches (jst_date);
create index owner_notification_batches_attempt_idx on public.owner_notification_batches (last_attempt_at desc);
create index owner_notification_batches_open_idx on public.owner_notification_batches (created_at)
  where status in ('sending', 'unknown');

alter table public.owner_notification_batches enable row level security;
-- ポリシーは作らない（authenticated・anon からは一切参照できない。service_role は RLS をバイパスする）

revoke all on public.owner_notification_batches from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.owner_notification_batches to service_role;

-- -----------------------------------------------------------------------------
-- 1. 送信するまとめの確保
--   戻り値（jsonb）：
--     {"result": "claimed", "batch_id", "retry_key", "event_ids", "pending_count", "urgent", "attempt"}
--         新しいまとめを作った。event_ids を 1 通にまとめて送り、finish_owner_notification_batch で結果を記録する
--     {"result": "retry", ...同上}  成否不明のまとめを同じ retry_key で再送する
--     {"result": "nothing"}        未通知のイベントがない
--     {"result": "throttled"}      前回の送信から間隔が空いていない
--     {"result": "daily_limit"}    今日の送信数が上限に達した
--     {"result": "busy"}           別の処理が送信中
--   引数が不正な場合は例外。
-- -----------------------------------------------------------------------------
create or replace function public.claim_owner_notification_batch(
  p_urgent boolean default false,
  p_interval_minutes integer default 10,
  p_daily_limit integer default 5,
  p_max_attempts integer default 3
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_interval interval;
  v_batch public.owner_notification_batches;
  v_ids text[];
  v_total integer;
  v_urgent boolean;
begin
  if p_urgent is null
     or p_interval_minutes is null or p_interval_minutes not between 1 and 1440
     or p_daily_limit is null or p_daily_limit not between 1 and 50
     or p_max_attempts is null or p_max_attempts not between 1 and 5 then
    raise exception 'invalid owner notification limit';
  end if;
  -- ロック取得後の状態を新しいスナップショットで読むため、READ COMMITTED を前提にする（reserve_ai_usage と同じ）
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'claim_owner_notification_batch requires read committed isolation';
  end if;
  v_interval := make_interval(mins => p_interval_minutes);

  -- 確認と確保をまとめて直列化する（同時に呼ばれても 1 通だけ）。トランザクション終了で解放
  perform pg_advisory_xact_lock(7461801206180002);

  delete from public.owner_notification_batches b where b.created_at < now() - interval '30 days';

  -- 送信中のまま 2 分以上たったもの（処理が途中で止まった）は成否不明として扱う
  update public.owner_notification_batches b
     set status = 'unknown', last_error = 'stalled_sending'
   where b.status = 'sending' and b.last_attempt_at < now() - interval '2 minutes';

  if exists (select 1 from public.owner_notification_batches b where b.status = 'sending') then
    return jsonb_build_object('result', 'busy');
  end if;

  -- 再送できない成否不明のまとめは打ち切る（対象のイベントは未通知のまま残り、次のまとめに含まれる）
  update public.owner_notification_batches b
     set status = 'abandoned', finished_at = now(), last_error = 'retry_exhausted'
   where b.status = 'unknown'
     and (b.attempts >= p_max_attempts or b.created_at < now() - interval '23 hours');

  -- 成否不明のまとめは、同じ retry_key で再送する（LINE 側で二重送信を防ぐ）
  select * into v_batch
    from public.owner_notification_batches b
   where b.status = 'unknown'
   order by b.created_at
   limit 1;
  if found then
    if v_batch.last_attempt_at > now() - v_interval then
      return jsonb_build_object('result', 'throttled');
    end if;
    update public.owner_notification_batches b
       set status = 'sending', attempts = b.attempts + 1, last_attempt_at = now()
     where b.id = v_batch.id
    returning * into v_batch;
    return jsonb_build_object(
      'result', 'retry', 'batch_id', v_batch.id, 'retry_key', v_batch.retry_key,
      'event_ids', to_jsonb(v_batch.event_ids), 'pending_count', cardinality(v_batch.event_ids),
      'urgent', v_batch.urgent, 'attempt', v_batch.attempts);
  end if;

  -- 未通知のイベント（保持期間 7 日以内）。送信中・成否不明のまとめに含まれるものは除く
  select count(*)::integer into v_total
    from public.line_webhook_events e
   where e.needs_owner_notification and e.owner_notified_at is null
     and e.received_at > now() - interval '7 days'
     and not exists (select 1 from public.owner_notification_batches b
                      where b.status in ('sending', 'unknown') and e.webhook_event_id = any (b.event_ids));
  if v_total = 0 then
    return jsonb_build_object('result', 'nothing');
  end if;

  v_urgent := p_urgent and not exists (
    select 1 from public.owner_notification_batches b where b.urgent and b.jst_date = v_today);
  if not v_urgent then
    if exists (select 1 from public.owner_notification_batches b where b.last_attempt_at > now() - v_interval) then
      return jsonb_build_object('result', 'throttled');
    end if;
    if (select count(*) from public.owner_notification_batches b
         where b.jst_date = v_today and not b.urgent) >= p_daily_limit then
      return jsonb_build_object('result', 'daily_limit');
    end if;
  end if;

  select array_agg(s.webhook_event_id order by s.received_at desc, s.webhook_event_id) into v_ids
    from (select e.webhook_event_id, e.received_at
            from public.line_webhook_events e
           where e.needs_owner_notification and e.owner_notified_at is null
             and e.received_at > now() - interval '7 days'
             and not exists (select 1 from public.owner_notification_batches b
                              where b.status in ('sending', 'unknown') and e.webhook_event_id = any (b.event_ids))
           order by e.received_at desc, e.webhook_event_id
           limit 200) s;

  insert into public.owner_notification_batches (event_ids, urgent, jst_date)
  values (v_ids, v_urgent, v_today)
  returning * into v_batch;

  return jsonb_build_object(
    'result', 'claimed', 'batch_id', v_batch.id, 'retry_key', v_batch.retry_key,
    'event_ids', to_jsonb(v_batch.event_ids), 'pending_count', v_total,
    'urgent', v_batch.urgent, 'attempt', v_batch.attempts);
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. 送信結果の記録（sending からのみ遷移）
--   sent    : まとめに含めたイベントと会話ログに owner_notified_at を記録する
--   failed  : LINE が拒否（4xx）。対象は未通知のまま残り、次のまとめに含まれる
--   unknown : 成否不明（5xx・タイムアウト）。次回、同じ retry_key で再送する
-- -----------------------------------------------------------------------------
create or replace function public.finish_owner_notification_batch(
  p_batch_id uuid,
  p_result text,
  p_error text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ids text[];
begin
  if p_result is null or p_result not in ('sent', 'failed', 'unknown') then
    raise exception 'invalid owner notification result';
  end if;
  if p_error is not null and p_error !~ '^[a-z0-9_:]{1,100}$' then
    raise exception 'invalid owner notification error code';
  end if;

  update public.owner_notification_batches b
     set status = p_result,
         finished_at = case when p_result = 'unknown' then null else now() end,
         last_error = case when p_result = 'sent' then null else coalesce(p_error, p_result) end
   where b.id = p_batch_id and b.status = 'sending'
  returning b.event_ids into v_ids;
  if not found then
    return false;
  end if;

  if p_result = 'sent' then
    update public.line_webhook_events e
       set owner_notified_at = now()
     where e.webhook_event_id = any (v_ids)
       and e.needs_owner_notification and e.owner_notified_at is null;
    update public.conversations c
       set owner_notified_at = now()
     where c.line_event_id = any (v_ids)
       and c.needs_owner and c.owner_notified_at is null;
  end if;
  return true;
end;
$$;

revoke all on function public.claim_owner_notification_batch(boolean, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.finish_owner_notification_batch(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_owner_notification_batch(boolean, integer, integer, integer) to service_role;
grant execute on function public.finish_owner_notification_batch(uuid, text, text) to service_role;
