-- =============================================================================
-- service_role のテーブル権限を明示する（WBS 1.2）
--
-- 変更理由
--   対象プロジェクト（dnortggovlwgcdeoadbf）で既定権限を読み取り専用で確認したところ、
--   postgres が public スキーマに作成するテーブルへ自動で付く権限は
--   anon / authenticated / service_role とも MAINTAIN, REFERENCES, TRIGGER, TRUNCATE だけで、
--   SELECT / INSERT / UPDATE / DELETE は付かなかった（2026-11-10 確認）。
--   初期 2 本は service_role の権限を既定権限に任せていたため、このままでは
--   security invoker の関数（Webhook 用 5 関数・start_broadcast_sending）が permission denied になる。
--
-- 方針
--   - 既定権限に依存しないよう、service_role の権限をいったんすべて剥奪してから、
--     サーバー処理に必要な操作だけを付与する（TRUNCATE などの不要な既定権限も外す）。
--   - anon / authenticated の権限・RLS・ポリシー・関数の実行権限は変更しない。
--   - service_role は BYPASSRLS のため RLS の対象外。テーブル権限が唯一の制限になる。
--
-- 付与する権限（サーバー処理 → 必要な操作）
--   line_webhook_events  SELECT, INSERT, UPDATE
--       claim_line_webhook_event（INSERT ... ON CONFLICT DO NOTHING）
--       begin_line_reply / record_line_reply_result / finish_line_webhook_event
--       mark_stalled_line_webhook_events（UPDATE ... WHERE / RETURNING のため SELECT も必要）
--       オーナー通知後の owner_notified_at 更新（WBS 2.5）
--       DELETE は付けない：保持期間の削除は private.purge_expired_data（security definer）が行う
--   conversations        SELECT, INSERT, UPDATE
--       会話ログの保存（upsert ... ignoreDuplicates と select）、通知済みの記録、未対応一覧
--       DELETE は付けない：同上
--   shop_settings        SELECT     … 応答の根拠（店舗情報・自動応答 ON/OFF・オーナー宛先）
--   faqs                 SELECT     … 応答の根拠（公開中の FAQ）
--   menus                SELECT     … 応答の根拠・金額の照合
--   broadcasts           SELECT, UPDATE
--       start_broadcast_sending（UPDATE ... RETURNING *）、テスト送信済み・送信結果の記録
--       INSERT / DELETE は付けない：下書きの作成・削除は管理画面（authenticated）が行う
--   admin_users          付与しない … 管理者の追加・削除は SQL エディタ（postgres）で行う
--
-- 将来、サーバー処理で新しい操作が必要になったら、このファイルは変更せず
-- 新しいマイグレーションで追加する。
-- =============================================================================

revoke all on table
  public.admin_users, public.shop_settings, public.faqs, public.menus,
  public.line_webhook_events, public.conversations, public.broadcasts
from service_role;

grant select, insert, update on public.line_webhook_events to service_role;
grant select, insert, update on public.conversations       to service_role;
grant select                 on public.shop_settings       to service_role;
grant select                 on public.faqs                to service_role;
grant select                 on public.menus               to service_role;
grant select, update         on public.broadcasts          to service_role;
