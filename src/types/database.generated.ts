// このファイルは自動生成です。手で編集しないこと。
// 生成: npm run gen:types（Supabase CLI supabase@3.1.0 / Project Ref dnortggovlwgcdeoadbf / schema public）
// 独自の型（CHECK 制約に対応する値の限定など）は src/types/database.ts に書く。

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      admin_users: {
        Row: {
          created_at: string
          display_name: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_usage_reservations: {
        Row: {
          jst_date: string
          reserved_at: string
          user_key: string
          webhook_event_id: string
        }
        Insert: {
          jst_date: string
          reserved_at?: string
          user_key: string
          webhook_event_id: string
        }
        Update: {
          jst_date?: string
          reserved_at?: string
          user_key?: string
          webhook_event_id?: string
        }
        Relationships: []
      }
      broadcasts: {
        Row: {
          body: string
          created_at: string
          created_by: string | null
          error_message: string | null
          estimated_recipients: number | null
          id: string
          quota_remaining_before: number | null
          retry_key: string
          sending_started_at: string | null
          sent_at: string | null
          status: string
          tested_at: string | null
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          created_by?: string | null
          error_message?: string | null
          estimated_recipients?: number | null
          id?: string
          quota_remaining_before?: number | null
          retry_key?: string
          sending_started_at?: string | null
          sent_at?: string | null
          status?: string
          tested_at?: string | null
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          created_by?: string | null
          error_message?: string | null
          estimated_recipients?: number | null
          id?: string
          quota_remaining_before?: number | null
          retry_key?: string
          sending_started_at?: string | null
          sent_at?: string | null
          status?: string
          tested_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "broadcasts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "admin_users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      conversations: {
        Row: {
          ai_category: string | null
          ai_reason: string | null
          ai_status: string
          bot_reply: string | null
          created_at: string
          error_message: string | null
          id: string
          input_tokens: number | null
          latency_ms: number | null
          line_event_id: string
          line_user_id: string
          message_type: string
          model: string | null
          needs_owner: boolean
          output_tokens: number | null
          owner_notified_at: string | null
          reply_method: string
          resolved_at: string | null
          resolved_by: string | null
          source_faq_ids: string[]
          source_menu_ids: string[]
          source_shop_fields: string[]
          user_message: string | null
        }
        Insert: {
          ai_category?: string | null
          ai_reason?: string | null
          ai_status: string
          bot_reply?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          input_tokens?: number | null
          latency_ms?: number | null
          line_event_id: string
          line_user_id: string
          message_type: string
          model?: string | null
          needs_owner?: boolean
          output_tokens?: number | null
          owner_notified_at?: string | null
          reply_method?: string
          resolved_at?: string | null
          resolved_by?: string | null
          source_faq_ids?: string[]
          source_menu_ids?: string[]
          source_shop_fields?: string[]
          user_message?: string | null
        }
        Update: {
          ai_category?: string | null
          ai_reason?: string | null
          ai_status?: string
          bot_reply?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          input_tokens?: number | null
          latency_ms?: number | null
          line_event_id?: string
          line_user_id?: string
          message_type?: string
          model?: string | null
          needs_owner?: boolean
          output_tokens?: number | null
          owner_notified_at?: string | null
          reply_method?: string
          resolved_at?: string | null
          resolved_by?: string | null
          source_faq_ids?: string[]
          source_menu_ids?: string[]
          source_shop_fields?: string[]
          user_message?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "admin_users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      faqs: {
        Row: {
          answer: string
          category: string
          created_at: string
          id: string
          is_published: boolean
          question: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          answer: string
          category?: string
          created_at?: string
          id?: string
          is_published?: boolean
          question: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          answer?: string
          category?: string
          created_at?: string
          id?: string
          is_published?: boolean
          question?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      line_webhook_events: {
        Row: {
          event_timestamp: string | null
          event_type: string
          is_redelivery: boolean
          last_error: string | null
          needs_owner_notification: boolean
          owner_notified_at: string | null
          processed_at: string | null
          processing_started_at: string
          received_at: string
          reply_attempted_at: string | null
          reply_deadline_at: string
          reply_status: string
          status: string
          webhook_event_id: string
        }
        Insert: {
          event_timestamp?: string | null
          event_type: string
          is_redelivery?: boolean
          last_error?: string | null
          needs_owner_notification?: boolean
          owner_notified_at?: string | null
          processed_at?: string | null
          processing_started_at?: string
          received_at?: string
          reply_attempted_at?: string | null
          reply_deadline_at?: string
          reply_status?: string
          status?: string
          webhook_event_id: string
        }
        Update: {
          event_timestamp?: string | null
          event_type?: string
          is_redelivery?: boolean
          last_error?: string | null
          needs_owner_notification?: boolean
          owner_notified_at?: string | null
          processed_at?: string | null
          processing_started_at?: string
          received_at?: string
          reply_attempted_at?: string | null
          reply_deadline_at?: string
          reply_status?: string
          status?: string
          webhook_event_id?: string
        }
        Relationships: []
      }
      menus: {
        Row: {
          category: string
          created_at: string
          description: string
          duration_min: number | null
          id: string
          is_published: boolean
          name: string
          price: number
          price_note: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          category?: string
          created_at?: string
          description?: string
          duration_min?: number | null
          id?: string
          is_published?: boolean
          name: string
          price: number
          price_note?: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          description?: string
          duration_min?: number | null
          id?: string
          is_published?: boolean
          name?: string
          price?: number
          price_note?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      owner_notification_batches: {
        Row: {
          attempts: number
          created_at: string
          event_ids: string[]
          finished_at: string | null
          id: string
          jst_date: string
          last_attempt_at: string
          last_error: string | null
          retry_key: string
          status: string
          urgent: boolean
        }
        Insert: {
          attempts?: number
          created_at?: string
          event_ids: string[]
          finished_at?: string | null
          id?: string
          jst_date: string
          last_attempt_at?: string
          last_error?: string | null
          retry_key?: string
          status?: string
          urgent?: boolean
        }
        Update: {
          attempts?: number
          created_at?: string
          event_ids?: string[]
          finished_at?: string | null
          id?: string
          jst_date?: string
          last_attempt_at?: string
          last_error?: string | null
          retry_key?: string
          status?: string
          urgent?: boolean
        }
        Relationships: []
      }
      shop_settings: {
        Row: {
          address: string
          bot_enabled: boolean
          business_hours: string
          fallback_message: string
          id: number
          owner_line_user_id: string | null
          parking: string
          phone: string
          regular_holidays: string
          reservation_guide: string
          shop_name: string
          temporary_notice: string
          updated_at: string
        }
        Insert: {
          address?: string
          bot_enabled?: boolean
          business_hours?: string
          fallback_message?: string
          id?: number
          owner_line_user_id?: string | null
          parking?: string
          phone?: string
          regular_holidays?: string
          reservation_guide?: string
          shop_name?: string
          temporary_notice?: string
          updated_at?: string
        }
        Update: {
          address?: string
          bot_enabled?: boolean
          business_hours?: string
          fallback_message?: string
          id?: number
          owner_line_user_id?: string | null
          parking?: string
          phone?: string
          regular_holidays?: string
          reservation_guide?: string
          shop_name?: string
          temporary_notice?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      begin_line_reply: {
        Args: { p_webhook_event_id: string }
        Returns: boolean
      }
      claim_line_webhook_event: {
        Args: {
          p_event_timestamp?: string
          p_event_type: string
          p_is_redelivery: boolean
          p_reply_window?: string
          p_webhook_event_id: string
        }
        Returns: boolean
      }
      claim_owner_notification_batch: {
        Args: {
          p_daily_limit?: number
          p_interval_minutes?: number
          p_max_attempts?: number
          p_urgent?: boolean
        }
        Returns: Json
      }
      finish_line_webhook_event: {
        Args: {
          p_error?: string
          p_needs_owner_notification?: boolean
          p_status: string
          p_webhook_event_id: string
        }
        Returns: boolean
      }
      finish_owner_notification_batch: {
        Args: { p_batch_id: string; p_error?: string; p_result: string }
        Returns: boolean
      }
      mark_stalled_line_webhook_events: {
        Args: { p_older_than?: string }
        Returns: {
          event_type: string
          received_at: string
          reply_status: string
          webhook_event_id: string
        }[]
      }
      record_line_reply_result: {
        Args: { p_result: string; p_webhook_event_id: string }
        Returns: boolean
      }
      reserve_ai_usage: {
        Args: {
          p_line_user_id: string
          p_shop_daily_limit?: number
          p_user_burst_limit?: number
          p_user_daily_limit?: number
          p_webhook_event_id: string
        }
        Returns: string
      }
      run_retention_purge: { Args: never; Returns: Json }
      start_broadcast_sending: {
        Args: {
          p_broadcast_id: string
          p_estimated_recipients: number
          p_quota_remaining: number
        }
        Returns: {
          body: string
          created_at: string
          created_by: string | null
          error_message: string | null
          estimated_recipients: number | null
          id: string
          quota_remaining_before: number | null
          retry_key: string
          sending_started_at: string | null
          sent_at: string | null
          status: string
          tested_at: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "broadcasts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
