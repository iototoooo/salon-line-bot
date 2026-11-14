-- =============================================================================
-- line_webhook_events.reply_status に 'simulated'（dry-run・未送信）を追加する
--
-- 変更理由
--   LINE_REPLY_MODE=dry-run では LINE へ送信しないが、従来は返信処理の完了を
--   'sent' として記録していたため、実際の送信成功と区別できなかった。
--   → dry-run の完了は 'simulated' として記録し、'sent' は LINE API が 2xx を返した場合だけにする。
--
-- 状態遷移（変更なし。終端の値が 1 つ増えるだけ）
--   none → sending → sent / simulated / failed / unknown
--   'simulated' も 'sent' と同じく終端で、再度の返信予約（begin_line_reply）はできない。
--
-- 既存のマイグレーションは変更しない。既存行に 'simulated' はないため、制約の付け替えで失敗しない。
-- =============================================================================

alter table public.line_webhook_events
  drop constraint line_webhook_events_reply_status_check,
  add constraint line_webhook_events_reply_status_check
    check (reply_status in ('none', 'sending', 'sent', 'simulated', 'failed', 'unknown'));

comment on column public.line_webhook_events.reply_status is
  'none: 未試行 / sending: 送信中 / sent: LINE が受理（2xx） / simulated: dry-run のため未送信 / failed: LINE が拒否（未送信） / unknown: 成否不明（再送しない）';

-- 返信結果の記録（sending からのみ遷移）。'simulated' を受け付ける以外は 2 本目と同じ
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
  if p_result not in ('sent', 'simulated', 'failed', 'unknown') then
    raise exception 'invalid reply result: %', p_result;
  end if;

  update public.line_webhook_events
     set reply_status = p_result
   where webhook_event_id = p_webhook_event_id
     and reply_status = 'sending';
  return found;
end;
$$;

-- create or replace は既存の権限を引き継ぐが、意図を明示するため付け直す（サーバー専用）
revoke all on function public.record_line_reply_result(text, text) from public, anon, authenticated;
grant execute on function public.record_line_reply_result(text, text) to service_role;
