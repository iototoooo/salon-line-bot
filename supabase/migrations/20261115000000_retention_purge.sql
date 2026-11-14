-- =============================================================================
-- 保持期間を過ぎたデータの定期削除（8 本目）
--
-- 目的
--   1 本目で作った private.purge_expired_data（会話ログ 90 日・Webhook イベント 7 日）は、
--   定期実行の仕組みがなく、private スキーマは API（PostgREST）に公開されていないため、サーバーから呼べなかった。
--   API から呼べる入口 public.run_retention_purge() を追加し、Vercel Schedules（1 日 1 回）から
--   /api/cron/retention 経由で呼ぶ。pg_cron（拡張機能の有効化が必要）は使わない。
--
-- 保持期間（関数の中で固定。呼び出し側からは変更できない）
--   conversations               90 日（created_at）。未対応のまま 90 日を過ぎた会話も削除する
--   line_webhook_events          7 日（received_at）
--   ai_usage_reservations        2 日（reserved_at）。reserve_ai_usage の中でも同じ条件で削除している
--   owner_notification_batches  30 日（created_at）。送信中・成否不明（sending / unknown）は残す
--                               （claim_owner_notification_batch の中でも 30 日で削除している）
--   admin_users・shop_settings・faqs・menus・broadcasts は削除しない
--
-- 安全性
--   - 引数なし。保持期間を短くして呼ぶことはできない（誤って新しいデータを消さない）
--   - 同時に呼ばれた場合（定期実行の重複・遅延後のまとめ実行）は、2 つ目は何もせず {"result":"busy"} を返す
--   - 何度実行しても、削除されるのは期限切れの行だけ（2 回目以降は 0 件）
--   - 通知のまとめの削除は、claim_owner_notification_batch と同じロックで直列化する
--   - 戻り値は件数のみ（ID・本文・ユーザー ID は返さない）
--
-- 権限
--   security invoker（呼び出したロールの権限で動く）。EXECUTE は service_role のみ。
--   service_role は 1〜7 本目で付与済みの権限（purge_expired_data の EXECUTE、
--   ai_usage_reservations・owner_notification_batches の DELETE）だけを使う。既存の権限は変更しない。
-- =============================================================================

create or replace function public.run_retention_purge()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_conv bigint;
  v_evt  bigint;
  v_usage bigint;
  v_batches bigint;
begin
  -- 削除処理どうしの重複を防ぐ（取れなければ別の実行が動いているので何もしない）
  if not pg_try_advisory_xact_lock(7461801206180003) then
    return jsonb_build_object('result', 'busy');
  end if;

  select p.deleted_conversations, p.deleted_events
    into v_conv, v_evt
    from private.purge_expired_data(interval '90 days', interval '7 days') p;

  delete from public.ai_usage_reservations r where r.reserved_at < now() - interval '2 days';
  get diagnostics v_usage = row_count;

  -- 通知のまとめの確保（claim_owner_notification_batch）と同じロック。確保の途中に削除しない
  perform pg_advisory_xact_lock(7461801206180002);
  delete from public.owner_notification_batches b
   where b.created_at < now() - interval '30 days'
     and b.status not in ('sending', 'unknown');
  get diagnostics v_batches = row_count;

  return jsonb_build_object(
    'result', 'purged',
    'conversations', v_conv,
    'line_webhook_events', v_evt,
    'ai_usage_reservations', v_usage,
    'owner_notification_batches', v_batches
  );
end;
$$;

comment on function public.run_retention_purge() is
  '保持期間を過ぎたデータの削除（会話 90 日・Webhook イベント 7 日・利用枠 2 日・通知記録 30 日）。件数のみ返す。service_role 専用';

revoke all on function public.run_retention_purge() from public, anon, authenticated;
grant execute on function public.run_retention_purge() to service_role;
