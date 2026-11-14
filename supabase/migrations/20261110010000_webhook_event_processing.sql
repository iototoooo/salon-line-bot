-- =============================================================================
-- line_webhook_events の処理状況管理（WBS 1.2）
--
-- 変更理由（初期マイグレーションからの差分）
--   1. 返信トークンは原則 1 回のみ・受信後 1 分以内しか使えない（LINE 仕様）。
--      → 返信の期限 reply_deadline_at と、返信の試行状況 reply_status を記録し、
--        期限切れ・使用済みのトークンで二重に返信しない。
--   2. LINE の再送は 2xx 応答後の処理失敗を回復しない（LINE 仕様）。
--      → 処理途中で停止したイベントを検出（abandoned）し、オーナー通知につなげる。
--   3. 返信 API の成否が不明（タイムアウト等）な場合に再送しないよう、
--      reply_status = 'unknown' を区別する。
--   4. 状態遷移の判定を DB 側の関数に集約し、並列実行でも 1 回だけ成功させる。
--
-- 既存の 7 日保持（private.purge_expired_data）はそのまま適用される。
-- =============================================================================

-- 初期マイグレーションの CHECK 制約を置き換える（名前は PostgreSQL の既定命名）
alter table public.line_webhook_events
  drop constraint line_webhook_events_status_check,
  drop constraint line_webhook_events_check;

alter table public.line_webhook_events
  add column event_timestamp           timestamptz,
  add column processing_started_at     timestamptz not null default now(),
  add column reply_deadline_at         timestamptz not null default (now() + interval '50 seconds'),
  add column reply_status              text not null default 'none',
  add column reply_attempted_at        timestamptz,
  add column last_error                text,
  add column needs_owner_notification  boolean not null default false,
  add column owner_notified_at         timestamptz;

alter table public.line_webhook_events
  add constraint line_webhook_events_status_check
    check (status in ('processing', 'done', 'skipped', 'failed', 'abandoned')),
  add constraint line_webhook_events_processed_at_check
    check ((status = 'processing') = (processed_at is null)),
  add constraint line_webhook_events_reply_status_check
    check (reply_status in ('none', 'sending', 'sent', 'failed', 'unknown')),
  add constraint line_webhook_events_reply_attempted_check
    check ((reply_status = 'none') = (reply_attempted_at is null)),
  -- エラー内容に個人情報・本文を含めない前提で、長さも制限する
  add constraint line_webhook_events_last_error_check
    check (last_error is null or char_length(last_error) <= 300),
  add constraint line_webhook_events_owner_notified_check
    check (owner_notified_at is null or needs_owner_notification);

comment on column public.line_webhook_events.reply_deadline_at is
  '返信トークンを使ってよい期限。LINE 仕様（受信後 1 分以内）に安全余裕を持たせて受信時刻 + 50 秒';
comment on column public.line_webhook_events.reply_status is
  'none: 未試行 / sending: 送信中 / sent: 成功 / failed: LINE が拒否（未送信） / unknown: 成否不明（再送しない）';

-- 停止イベントの検出用
create index line_webhook_events_processing_idx
  on public.line_webhook_events (processing_started_at)
  where status = 'processing';
-- 未通知の要対応イベント（将来のオーナー通知用）
create index line_webhook_events_owner_pending_idx
  on public.line_webhook_events (received_at)
  where needs_owner_notification and owner_notified_at is null;

-- -----------------------------------------------------------------------------
-- 1. 処理権の取得：初回のみ true。並列に呼ばれても true は 1 回だけ。
-- -----------------------------------------------------------------------------
create or replace function public.claim_line_webhook_event(
  p_webhook_event_id text,
  p_event_type text,
  p_is_redelivery boolean,
  p_event_timestamp timestamptz default null,
  p_reply_window interval default interval '50 seconds'
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_reply_window <= interval '0' or p_reply_window > interval '1 minute' then
    raise exception 'reply window must be within (0, 1 minute]';
  end if;

  insert into public.line_webhook_events (
    webhook_event_id, event_type, is_redelivery, event_timestamp,
    received_at, processing_started_at, reply_deadline_at
  ) values (
    p_webhook_event_id, p_event_type, p_is_redelivery, p_event_timestamp,
    now(), now(), now() + p_reply_window
  )
  on conflict (webhook_event_id) do nothing;

  return found;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. 返信の予約：返信トークンを使う直前に呼ぶ。
--    未試行・処理中・期限内のときだけ true（= このトークンで 1 回だけ送ってよい）。
-- -----------------------------------------------------------------------------
create or replace function public.begin_line_reply(p_webhook_event_id text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.line_webhook_events
     set reply_status = 'sending',
         reply_attempted_at = now()
   where webhook_event_id = p_webhook_event_id
     and status = 'processing'
     and reply_status = 'none'
     and now() < reply_deadline_at;
  return found;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. 返信結果の記録（sending からのみ遷移）
-- -----------------------------------------------------------------------------
create or replace function public.record_line_reply_result(
  p_webhook_event_id text,
  p_result text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_result not in ('sent', 'failed', 'unknown') then
    raise exception 'invalid reply result: %', p_result;
  end if;

  update public.line_webhook_events
     set reply_status = p_result
   where webhook_event_id = p_webhook_event_id
     and reply_status = 'sending';
  return found;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. 処理の終了（processing からのみ遷移）
--    送信中のまま終了した場合、成否は不明として unknown にする。
-- -----------------------------------------------------------------------------
create or replace function public.finish_line_webhook_event(
  p_webhook_event_id text,
  p_status text,
  p_error text default null,
  p_needs_owner_notification boolean default false
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_status not in ('done', 'skipped', 'failed') then
    raise exception 'invalid final status: %', p_status;
  end if;

  update public.line_webhook_events
     set status = p_status,
         processed_at = now(),
         last_error = left(p_error, 300),
         needs_owner_notification = needs_owner_notification or p_needs_owner_notification,
         reply_status = case when reply_status = 'sending' then 'unknown' else reply_status end
   where webhook_event_id = p_webhook_event_id
     and status = 'processing';
  return found;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. 停止イベントの検出：一定時間 processing のままのイベントを abandoned にする。
--    返信トークンは期限切れのため再返信はせず、オーナー通知の対象にする。
--    定期実行（Cron）から呼ぶ想定。
-- -----------------------------------------------------------------------------
create or replace function public.mark_stalled_line_webhook_events(
  p_older_than interval default interval '5 minutes'
)
returns table (webhook_event_id text, event_type text, reply_status text, received_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- 正常処理中のイベントを誤って打ち切らないよう、返信期限（1 分）より十分長くする
  if p_older_than < interval '2 minutes' then
    raise exception 'p_older_than must be at least 2 minutes';
  end if;

  return query
  update public.line_webhook_events e
     set status = 'abandoned',
         processed_at = now(),
         last_error = 'stalled: processing did not finish',
         needs_owner_notification = true,
         reply_status = case when e.reply_status = 'sending' then 'unknown' else e.reply_status end
   where e.status = 'processing'
     and e.processing_started_at < now() - p_older_than
  returning e.webhook_event_id, e.event_type, e.reply_status, e.received_at;
end;
$$;

-- -----------------------------------------------------------------------------
-- 権限：すべてサーバー（service_role）専用
-- -----------------------------------------------------------------------------
revoke all on function public.claim_line_webhook_event(text, text, boolean, timestamptz, interval) from public, anon, authenticated;
revoke all on function public.begin_line_reply(text) from public, anon, authenticated;
revoke all on function public.record_line_reply_result(text, text) from public, anon, authenticated;
revoke all on function public.finish_line_webhook_event(text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.mark_stalled_line_webhook_events(interval) from public, anon, authenticated;

grant execute on function public.claim_line_webhook_event(text, text, boolean, timestamptz, interval) to service_role;
grant execute on function public.begin_line_reply(text) to service_role;
grant execute on function public.record_line_reply_result(text, text) to service_role;
grant execute on function public.finish_line_webhook_event(text, text, text, boolean) to service_role;
grant execute on function public.mark_stalled_line_webhook_events(interval) to service_role;
