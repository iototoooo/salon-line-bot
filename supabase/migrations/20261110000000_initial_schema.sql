-- =============================================================================
-- 初期スキーマ：美容室 LINE 自動応答システム
-- 参照：docs/requirements.md, docs/architecture.md（4. データベース設計）
--
-- 権限の考え方
--   anon            : 一切アクセス不可
--   authenticated   : admin_users に登録されたユーザーだけが RLS で許可される
--   service_role    : サーバー側処理（Webhook・配信）専用。RLS をバイパスする
--
-- 個人情報の方針
--   保存するのは LINE ユーザーID とメッセージ本文のみ。表示名・プロフィール画像は保存しない。
--   会話ログは 90 日、Webhook イベント記録は 7 日で削除する（private.purge_expired_data）。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. スキーマ・共通関数
-- -----------------------------------------------------------------------------

-- API（PostgREST）に公開しない内部用スキーマ
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- updated_at 自動更新
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 1. admin_users：管理画面にログインできるユーザーの許可リスト
--    追加・削除は service_role（SQL エディタ等）からのみ行う。
-- -----------------------------------------------------------------------------
create table public.admin_users (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 50),
  created_at   timestamptz not null default now()
);

comment on table public.admin_users is '管理画面の利用を許可するユーザー（Supabase Auth の user id）';

-- 管理者判定（RLS ポリシーから使用）
-- security definer にして admin_users の RLS による再帰を避ける
create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users where user_id = (select auth.uid())
  );
$$;

revoke all on function private.is_admin() from public;
grant execute on function private.is_admin() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. shop_settings：店舗基本情報（常に 1 行）
-- -----------------------------------------------------------------------------
create table public.shop_settings (
  id                  smallint primary key default 1 check (id = 1),
  shop_name           text not null default '' check (char_length(shop_name) <= 100),
  business_hours      text not null default '' check (char_length(business_hours) <= 1000),
  regular_holidays    text not null default '' check (char_length(regular_holidays) <= 500),
  address             text not null default '' check (char_length(address) <= 300),
  phone               text not null default '' check (char_length(phone) <= 30),
  parking             text not null default '' check (char_length(parking) <= 1000),
  reservation_guide   text not null default '' check (char_length(reservation_guide) <= 1000),
  temporary_notice    text not null default '' check (char_length(temporary_notice) <= 1000),
  bot_enabled         boolean not null default false, -- 初期データ登録が終わるまで OFF
  fallback_message    text not null
    default 'お問い合わせありがとうございます。担当者が確認して、改めてご連絡いたします。'
    check (char_length(fallback_message) between 1 and 500),
  owner_line_user_id  text check (owner_line_user_id is null or owner_line_user_id ~ '^U[0-9a-f]{32}$'),
  updated_at          timestamptz not null default now()
);

comment on column public.shop_settings.bot_enabled is '自動応答 ON/OFF（緊急停止スイッチ）。false の場合は fallback_message のみ返す';
comment on column public.shop_settings.owner_line_user_id is 'オーナー通知・テスト送信の宛先。push の宛先はこの値に限定する';

create trigger shop_settings_set_updated_at
  before update on public.shop_settings
  for each row execute function private.set_updated_at();

insert into public.shop_settings (id) values (1);

-- -----------------------------------------------------------------------------
-- 3. faqs：よくある質問
-- -----------------------------------------------------------------------------
create table public.faqs (
  id            uuid primary key default gen_random_uuid(),
  question      text not null check (char_length(question) between 1 and 300),
  answer        text not null check (char_length(answer) between 1 and 2000),
  category      text not null default 'other'
    check (category in ('hours', 'price', 'reservation', 'treatment', 'access', 'other')),
  is_published  boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index faqs_published_sort_idx on public.faqs (is_published, sort_order);

create trigger faqs_set_updated_at
  before update on public.faqs
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. menus：メニュー・料金（税込・円・整数）
-- -----------------------------------------------------------------------------
create table public.menus (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(name) between 1 and 100),
  category      text not null default 'other'
    check (category in ('cut', 'color', 'perm', 'treatment', 'set', 'other')),
  price         integer not null check (price between 0 and 1000000),
  price_note    text not null default '' check (char_length(price_note) <= 200),
  duration_min  integer check (duration_min is null or duration_min between 1 and 600),
  description   text not null default '' check (char_length(description) <= 1000),
  is_published  boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on column public.menus.price is '税込金額（円）。AI には計算させず、この値をそのまま提示する';

create index menus_published_sort_idx on public.menus (is_published, category, sort_order);

create trigger menus_set_updated_at
  before update on public.menus
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- 5. line_webhook_events：Webhook イベントの重複処理防止
--    受信直後に INSERT ... ON CONFLICT DO NOTHING で「処理権」を取得する。
--    挿入できなかった（既に存在する）イベントは再配信・同時実行とみなして処理しない。
--    個人情報（ユーザーID・本文）は保存しない。
-- -----------------------------------------------------------------------------
create table public.line_webhook_events (
  webhook_event_id  text primary key check (char_length(webhook_event_id) between 1 and 100),
  event_type        text not null check (char_length(event_type) between 1 and 50),
  is_redelivery     boolean not null default false,
  status            text not null default 'processing'
    check (status in ('processing', 'done', 'skipped', 'failed')),
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  check ((status = 'processing') = (processed_at is null))
);

create index line_webhook_events_received_at_idx on public.line_webhook_events (received_at);

-- -----------------------------------------------------------------------------
-- 6. conversations：会話ログ（1 行 = お客様の 1 メッセージとその応答）
-- -----------------------------------------------------------------------------
create table public.conversations (
  id                 uuid primary key default gen_random_uuid(),
  -- line_webhook_events は 7 日で削除するため外部キーにはせず、unique で二重保存を防ぐ
  line_event_id      text not null unique check (char_length(line_event_id) between 1 and 100),
  line_user_id       text not null check (line_user_id ~ '^U[0-9a-f]{32}$'),
  message_type       text not null check (char_length(message_type) between 1 and 30),
  user_message       text check (user_message is null or char_length(user_message) <= 5000),
  ai_status          text not null
    check (ai_status in ('answered', 'cannot_answer', 'reservation', 'bot_off', 'error', 'unsupported')),
  ai_category        text
    check (ai_category is null or ai_category in ('hours', 'price', 'reservation', 'treatment', 'access', 'other')),
  bot_reply          text check (bot_reply is null or char_length(bot_reply) <= 5000),
  reply_method       text not null default 'none' check (reply_method in ('reply', 'push', 'none')),
  needs_owner        boolean not null default false,
  owner_notified_at  timestamptz,
  resolved_at        timestamptz,
  resolved_by        uuid references public.admin_users (user_id) on delete set null,
  model              text check (model is null or char_length(model) <= 100),
  input_tokens       integer check (input_tokens is null or input_tokens >= 0),
  output_tokens      integer check (output_tokens is null or output_tokens >= 0),
  latency_ms         integer check (latency_ms is null or latency_ms >= 0),
  error_message      text check (error_message is null or char_length(error_message) <= 1000),
  created_at         timestamptz not null default now(),
  check (resolved_by is null or resolved_at is not null)
);

comment on table public.conversations is '会話ログ。保持期間 90 日（private.purge_expired_data で削除）';
comment on column public.conversations.error_message is '個人情報・メッセージ本文を含めないこと';

create index conversations_created_at_idx on public.conversations (created_at desc);
-- 未対応一覧（needs_owner かつ未解決）用の部分インデックス
create index conversations_unresolved_idx on public.conversations (created_at desc)
  where needs_owner and resolved_at is null;
create index conversations_user_created_idx on public.conversations (line_user_id, created_at desc);
create index conversations_resolved_by_idx on public.conversations (resolved_by);

-- -----------------------------------------------------------------------------
-- 7. broadcasts：お知らせ一斉配信
--    状態遷移：draft → tested → sending → sent / failed（failed → sending の再試行のみ可）
--    二重送信防止：
--      (1) private.broadcasts_guard で不正な状態遷移を拒否
--      (2) public.start_broadcast_sending の条件付き UPDATE で「送信権」を 1 回だけ取得
--      (3) sending 状態は全体で同時に 1 件まで（部分ユニークインデックス）
--      (4) retry_key を LINE の X-Line-Retry-Key に使い、API 側でも冪等化
-- -----------------------------------------------------------------------------
create table public.broadcasts (
  id                      uuid primary key default gen_random_uuid(),
  -- 上限 5000 文字は LINE テキストメッセージの上限を想定（要確認）
  body                    text not null check (char_length(body) between 1 and 5000),
  status                  text not null default 'draft'
    check (status in ('draft', 'tested', 'sending', 'sent', 'failed')),
  retry_key               uuid not null unique default gen_random_uuid(),
  estimated_recipients    integer check (estimated_recipients is null or estimated_recipients >= 0),
  quota_remaining_before  integer check (quota_remaining_before is null or quota_remaining_before >= 0),
  tested_at               timestamptz,
  sending_started_at      timestamptz,
  sent_at                 timestamptz,
  created_by              uuid default auth.uid() references public.admin_users (user_id) on delete set null,
  error_message           text check (error_message is null or char_length(error_message) <= 1000),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  check (status = 'draft' or tested_at is not null),
  check (status not in ('sending', 'sent', 'failed') or sending_started_at is not null),
  check (status <> 'sent' or sent_at is not null)
);

-- 同時に「送信中」になれる配信は 1 件だけ
create unique index broadcasts_one_sending_idx on public.broadcasts ((true)) where status = 'sending';
create index broadcasts_created_at_idx on public.broadcasts (created_at desc);
create index broadcasts_created_by_idx on public.broadcasts (created_by);

create or replace function private.broadcasts_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- 送信中・送信済みの本文は変更不可
  if new.body is distinct from old.body then
    if old.status in ('sending', 'sent') then
      raise exception 'broadcast % is % and its body cannot be changed', old.id, old.status;
    end if;
    -- 本文を変えたらテスト送信からやり直す
    new.status := 'draft';
    new.tested_at := null;
  end if;

  -- 再送信キーは変更不可（LINE 側の冪等性を保つ）
  if new.retry_key is distinct from old.retry_key then
    raise exception 'retry_key cannot be changed';
  end if;

  if new.status is distinct from old.status and not (
       (old.status = 'draft'   and new.status = 'tested')
    or (old.status = 'tested'  and new.status in ('draft', 'sending'))
    or (old.status = 'sending' and new.status in ('sent', 'failed'))
    or (old.status = 'failed'  and new.status in ('sending', 'draft'))
  ) then
    raise exception 'invalid broadcast status transition: % -> %', old.status, new.status;
  end if;

  -- failed → draft（本文修正）では新しい配信として扱うため、再送信キーを振り直す
  if old.status = 'failed' and new.status = 'draft' then
    new.retry_key := gen_random_uuid();
    new.sending_started_at := null;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger broadcasts_guard
  before update on public.broadcasts
  for each row execute function private.broadcasts_guard();

-- 送信権の取得（サーバー＝service_role からのみ呼ぶ）
-- 条件を満たす場合のみ 1 行を sending に更新して返す。満たさなければ例外。
create or replace function public.start_broadcast_sending(
  p_broadcast_id uuid,
  p_estimated_recipients integer,
  p_quota_remaining integer
)
returns public.broadcasts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.broadcasts;
begin
  if p_estimated_recipients is null or p_quota_remaining is null
     or p_estimated_recipients < 0 or p_quota_remaining < 0 then
    raise exception 'recipient count and remaining quota are required';
  end if;
  if p_estimated_recipients > p_quota_remaining then
    raise exception 'insufficient quota: recipients=%, remaining=%',
      p_estimated_recipients, p_quota_remaining;
  end if;

  update public.broadcasts
     set status = 'sending',
         estimated_recipients = p_estimated_recipients,
         quota_remaining_before = p_quota_remaining,
         sending_started_at = now(),
         error_message = null
   where id = p_broadcast_id
     and status in ('tested', 'failed')
     and tested_at is not null
  returning * into v_row;

  if not found then
    raise exception 'broadcast % is not ready to send (already sending/sent, or not tested)', p_broadcast_id;
  end if;

  return v_row;
end;
$$;

revoke all on function public.start_broadcast_sending(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.start_broadcast_sending(uuid, integer, integer) to service_role;

-- -----------------------------------------------------------------------------
-- 8. 保持期間による削除（会話ログ 90 日・Webhook イベント 7 日）
-- -----------------------------------------------------------------------------
create or replace function private.purge_expired_data(
  p_conversation_retention interval default interval '90 days',
  p_event_retention interval default interval '7 days'
)
returns table (deleted_conversations bigint, deleted_events bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv bigint;
  v_evt  bigint;
begin
  if p_conversation_retention < interval '1 day' or p_event_retention < interval '1 day' then
    raise exception 'retention must be at least 1 day';
  end if;

  delete from public.conversations where created_at < now() - p_conversation_retention;
  get diagnostics v_conv = row_count;

  delete from public.line_webhook_events where received_at < now() - p_event_retention;
  get diagnostics v_evt = row_count;

  return query select v_conv, v_evt;
end;
$$;

revoke all on function private.purge_expired_data(interval, interval) from public, anon, authenticated;
grant execute on function private.purge_expired_data(interval, interval) to service_role;

-- 定期実行の例（pg_cron を Supabase ダッシュボードで有効化した後に実行。利用条件は要確認）
--   select cron.schedule('purge-expired-data', '15 18 * * *',  -- 毎日 03:15 JST
--                        $$select private.purge_expired_data()$$);
-- pg_cron を使わない場合は Vercel Cron 等から service_role で呼び出す。

-- -----------------------------------------------------------------------------
-- 9. 権限（GRANT）と RLS
--    Supabase は public スキーマの新規テーブルに anon/authenticated へ全権限を付与するため、
--    いったん剥奪してから必要な操作だけを付与する。
-- -----------------------------------------------------------------------------
revoke all on table
  public.admin_users, public.shop_settings, public.faqs, public.menus,
  public.line_webhook_events, public.conversations, public.broadcasts
from anon, authenticated;

alter table public.admin_users          enable row level security;
alter table public.shop_settings        enable row level security;
alter table public.faqs                 enable row level security;
alter table public.menus                enable row level security;
alter table public.line_webhook_events  enable row level security;
alter table public.conversations        enable row level security;
alter table public.broadcasts           enable row level security;

-- admin_users：参照のみ（追加・削除は service_role）
grant select on public.admin_users to authenticated;
create policy admin_users_select on public.admin_users
  for select to authenticated using ((select private.is_admin()));

-- shop_settings：参照・更新のみ（行の追加・削除は不可、id は変更不可）
grant select on public.shop_settings to authenticated;
grant update (
  shop_name, business_hours, regular_holidays, address, phone, parking,
  reservation_guide, temporary_notice, bot_enabled, fallback_message, owner_line_user_id
) on public.shop_settings to authenticated;
create policy shop_settings_select on public.shop_settings
  for select to authenticated using ((select private.is_admin()));
create policy shop_settings_update on public.shop_settings
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- faqs：管理者は全操作可
grant select, insert, update, delete on public.faqs to authenticated;
create policy faqs_admin_all on public.faqs
  for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- menus：管理者は全操作可
grant select, insert, update, delete on public.menus to authenticated;
create policy menus_admin_all on public.menus
  for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- line_webhook_events：service_role のみ（authenticated には権限を付与しない）

-- conversations：参照と「対応済み」の更新のみ（ログ本体の改ざん・削除は不可）
grant select on public.conversations to authenticated;
grant update (resolved_at, resolved_by) on public.conversations to authenticated;
create policy conversations_select on public.conversations
  for select to authenticated using ((select private.is_admin()));
create policy conversations_resolve on public.conversations
  for update to authenticated
  using ((select private.is_admin()))
  with check (
    (select private.is_admin())
    and (resolved_by is null or resolved_by = (select auth.uid()))
  );

-- broadcasts：下書きの作成・本文編集・未送信分の削除のみ。
-- 状態の変更（tested / sending / sent / failed）はサーバー（service_role）が行う。
grant select on public.broadcasts to authenticated;
grant insert (body) on public.broadcasts to authenticated;
grant update (body) on public.broadcasts to authenticated;
grant delete on public.broadcasts to authenticated;
create policy broadcasts_select on public.broadcasts
  for select to authenticated using ((select private.is_admin()));
create policy broadcasts_insert on public.broadcasts
  for insert to authenticated
  with check ((select private.is_admin()) and status = 'draft');
create policy broadcasts_update on public.broadcasts
  for update to authenticated
  using ((select private.is_admin()) and status in ('draft', 'tested', 'failed'))
  with check ((select private.is_admin()));
create policy broadcasts_delete on public.broadcasts
  for delete to authenticated
  using ((select private.is_admin()) and status in ('draft', 'tested'));
