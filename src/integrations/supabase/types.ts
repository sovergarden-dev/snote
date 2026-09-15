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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      admin_auth_attempts: {
        Row: {
          failure_count: number
          first_failure_at: string
          lease_id: string | null
          lease_until: string | null
          locked_until: string | null
          subject_hash: string
        }
        Insert: {
          failure_count?: number
          first_failure_at?: string
          lease_id?: string | null
          lease_until?: string | null
          locked_until?: string | null
          subject_hash: string
        }
        Update: {
          failure_count?: number
          first_failure_at?: string
          lease_id?: string | null
          lease_until?: string | null
          locked_until?: string | null
          subject_hash?: string
        }
        Relationships: []
      }
      admin_auth_state: {
        Row: {
          credential_epoch: number
          id: number
          updated_at: string
        }
        Insert: {
          credential_epoch?: number
          id: number
          updated_at?: string
        }
        Update: {
          credential_epoch?: number
          id?: number
          updated_at?: string
        }
        Relationships: []
      }
      admin_config: {
        Row: {
          id: number
          pass_hash: string
          updated_at: string
        }
        Insert: {
          id?: number
          pass_hash: string
          updated_at?: string
        }
        Update: {
          id?: number
          pass_hash?: string
          updated_at?: string
        }
        Relationships: []
      }
      admin_sessions: {
        Row: {
          created_at: string
          expires_at: string
          subject_hash: string
          token_hash: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          subject_hash: string
          token_hash: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          subject_hash?: string
          token_hash?: string
        }
        Relationships: []
      }
      capability_admission_windows: {
        Row: {
          bucket_kind: string
          byte_count: number
          operation: string
          request_count: number
          subject_hash: string
          updated_at: string
          window_start: string
        }
        Insert: {
          bucket_kind: string
          byte_count: number
          operation: string
          request_count: number
          subject_hash: string
          updated_at?: string
          window_start: string
        }
        Update: {
          bucket_kind?: string
          byte_count?: number
          operation?: string
          request_count?: number
          subject_hash?: string
          updated_at?: string
          window_start?: string
        }
        Relationships: []
      }
      capability_runtime_settings: {
        Row: {
          private_realtime_enabled: boolean
          singleton: boolean
          updated_at: string
          writes_enabled: boolean
        }
        Insert: {
          private_realtime_enabled?: boolean
          singleton?: boolean
          updated_at?: string
          writes_enabled?: boolean
        }
        Update: {
          private_realtime_enabled?: boolean
          singleton?: boolean
          updated_at?: string
          writes_enabled?: boolean
        }
        Relationships: []
      }
      note_capabilities: {
        Row: {
          capability_id: string
          created_at: string
          generation: number
          last_used_at: string | null
          note_id: string
          revoked_at: string | null
          scope: Database["public"]["Enums"]["note_capability_scope"]
          token_hash: string
        }
        Insert: {
          capability_id?: string
          created_at?: string
          generation?: number
          last_used_at?: string | null
          note_id: string
          revoked_at?: string | null
          scope: Database["public"]["Enums"]["note_capability_scope"]
          token_hash: string
        }
        Update: {
          capability_id?: string
          created_at?: string
          generation?: number
          last_used_at?: string | null
          note_id?: string
          revoked_at?: string | null
          scope?: Database["public"]["Enums"]["note_capability_scope"]
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_capabilities_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["note_id"]
          },
        ]
      }
      note_checkpoints: {
        Row: {
          checkpoint_id: string
          created_at: string
          encryption_version: number
          note_id: string
          payload: string
          through_seq: number
          version: number
        }
        Insert: {
          checkpoint_id: string
          created_at?: string
          encryption_version: number
          note_id: string
          payload: string
          through_seq: number
          version: number
        }
        Update: {
          checkpoint_id?: string
          created_at?: string
          encryption_version?: number
          note_id?: string
          payload?: string
          through_seq?: number
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "note_checkpoints_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["note_id"]
          },
        ]
      }
      note_realtime_memberships: {
        Row: {
          auth_user_id: string
          capability_id: string
          created_at: string
          expires_at: string
          note_id: string
          refreshed_at: string
        }
        Insert: {
          auth_user_id: string
          capability_id: string
          created_at?: string
          expires_at: string
          note_id: string
          refreshed_at?: string
        }
        Update: {
          auth_user_id?: string
          capability_id?: string
          created_at?: string
          expires_at?: string
          note_id?: string
          refreshed_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_realtime_memberships_capability_id_note_id_fkey"
            columns: ["capability_id", "note_id"]
            isOneToOne: false
            referencedRelation: "note_capabilities"
            referencedColumns: ["capability_id", "note_id"]
          },
          {
            foreignKeyName: "note_realtime_memberships_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["note_id"]
          },
        ]
      }
      note_shares: {
        Row: {
          created_at: string
          slug: string
          token: string
        }
        Insert: {
          created_at?: string
          slug: string
          token: string
        }
        Update: {
          created_at?: string
          slug?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_shares_slug_fkey"
            columns: ["slug"]
            isOneToOne: true
            referencedRelation: "notes"
            referencedColumns: ["slug"]
          },
        ]
      }
      note_updates: {
        Row: {
          created_at: string
          encryption_version: number
          note_id: string
          payload: string
          seq: number
          update_id: string
        }
        Insert: {
          created_at?: string
          encryption_version: number
          note_id: string
          payload: string
          seq?: never
          update_id: string
        }
        Update: {
          created_at?: string
          encryption_version?: number
          note_id?: string
          payload?: string
          seq?: never
          update_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_updates_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["note_id"]
          },
        ]
      }
      notes: {
        Row: {
          capability_managed: boolean
          char_count: number
          checkpoint_limit_count: number
          content: string
          created_at: string
          deleted_at: string | null
          enc_check: string | null
          enc_iterations: number
          enc_salt: string | null
          encryption_version: number
          is_encrypted: boolean
          note_id: string
          payload_limit_bytes: number
          slug: string
          storage_limit_bytes: number
          sync_status: Database["public"]["Enums"]["note_sync_status"]
          tags: string[]
          update_limit_count: number
          updated_at: string
          ydoc_state: string
        }
        Insert: {
          capability_managed?: boolean
          char_count?: number
          checkpoint_limit_count?: number
          content?: string
          created_at?: string
          deleted_at?: string | null
          enc_check?: string | null
          enc_iterations?: number
          enc_salt?: string | null
          encryption_version?: number
          is_encrypted?: boolean
          note_id?: string
          payload_limit_bytes?: number
          slug: string
          storage_limit_bytes?: number
          sync_status?: Database["public"]["Enums"]["note_sync_status"]
          tags?: string[]
          update_limit_count?: number
          updated_at?: string
          ydoc_state?: string
        }
        Update: {
          capability_managed?: boolean
          char_count?: number
          checkpoint_limit_count?: number
          content?: string
          created_at?: string
          deleted_at?: string | null
          enc_check?: string | null
          enc_iterations?: number
          enc_salt?: string | null
          encryption_version?: number
          is_encrypted?: boolean
          note_id?: string
          payload_limit_bytes?: number
          slug?: string
          storage_limit_bytes?: number
          sync_status?: Database["public"]["Enums"]["note_sync_status"]
          tags?: string[]
          update_limit_count?: number
          updated_at?: string
          ydoc_state?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_auth_begin: {
        Args: { p_lease_id: string; p_subject_hash: string }
        Returns: {
          allowed: boolean
          retry_after_seconds: number
        }[]
      }
      admin_auth_complete: {
        Args: { p_lease_id: string; p_subject_hash: string; p_success: boolean }
        Returns: {
          allowed: boolean
          retry_after_seconds: number
        }[]
      }
      admin_credential_material: {
        Args: never
        Returns: {
          credential_epoch: number
          pass_hash: string
        }[]
      }
      admin_notes_delete: {
        Args: {
          p_all: boolean
          p_slugs: string[]
          p_subject_hash: string
          p_token_hash: string
        }
        Returns: Json
      }
      admin_notes_list: {
        Args: {
          p_limit: number
          p_offset: number
          p_search: string
          p_subject_hash: string
          p_tag: string
          p_token_hash: string
        }
        Returns: Json
      }
      admin_pass_rotate: {
        Args: {
          p_pass_hash: string
          p_subject_hash: string
          p_token_hash: string
        }
        Returns: undefined
      }
      admin_security_prune: {
        Args: never
        Returns: {
          expired_sessions: number
          stale_attempts: number
        }[]
      }
      admin_session_issue: {
        Args: {
          p_credential_epoch: number
          p_expires_at: string
          p_subject_hash: string
          p_token_hash: string
        }
        Returns: undefined
      }
      admin_session_revoke: {
        Args: { p_subject_hash: string; p_token_hash: string }
        Returns: undefined
      }
      admin_session_validate: {
        Args: { p_subject_hash: string; p_token_hash: string }
        Returns: boolean
      }
      capability_admission_consume: {
        Args: {
          p_byte_cost?: number
          p_operation: "create" | "sync" | "membership"
          p_request_cost?: number
          p_subject_hash: string
        }
        Returns: Json
      }
      capability_checkpoint_append: {
        Args: {
          p_checkpoint: Json
          p_expected_checkpoint_version: number
          p_expected_encryption_version: number
          p_token_hash: string
        }
        Returns: Json
      }
      capability_note_convert_legacy: {
        Args: {
          p_check: string
          p_checkpoint_id: string
          p_edit_token_hash: string
          p_is_encrypted: boolean
          p_iterations: number
          p_owner_token_hash: string
          p_payload_text: string
          p_salt: string
          p_slug: string
          p_view_token_hash: string
        }
        Returns: Json
      }
      capability_note_create: {
        Args: {
          p_edit_token_hash: string
          p_owner_token_hash: string
          p_slug: string
          p_view_token_hash: string
        }
        Returns: Json
      }
      capability_note_disable_secure: {
        Args: {
          p_char_count: number
          p_check: string
          p_content: string
          p_is_encrypted: boolean
          p_iterations: number
          p_owner_token_hash: string
          p_salt: string
          p_slug: string
          p_tags: string[]
          p_ydoc_state: string
        }
        Returns: Json
      }
      capability_note_import_legacy: {
        Args: {
          p_check: string
          p_checkpoint_id: string
          p_edit_token_hash: string
          p_is_encrypted: boolean
          p_iterations: number
          p_owner_token_hash: string
          p_payload_text: string
          p_salt: string
          p_slug: string
          p_view_token_hash: string
        }
        Returns: Json
      }
      capability_note_manage: {
        Args: { p_action: string; p_params?: Json; p_token_hash: string }
        Returns: Json
      }
      capability_note_plain_upsert: {
        Args: {
          p_char_count: number
          p_check: string
          p_content: string
          p_is_encrypted: boolean
          p_iterations: number
          p_salt: string
          p_slug: string
          p_tags: string[]
          p_ydoc_state: string
        }
        Returns: Json
      }
      capability_payload_audit: {
        Args: { p_soft_limit?: number }
        Returns: {
          max_checkpoint_bytes: number
          max_legacy_snapshot_bytes: number
          max_update_bytes: number
          notes_above_limit: number
          total_notes: number
        }[]
      }
      capability_quarantine_oversized: { Args: never; Returns: number }
      capability_realtime_cleanup_candidates: {
        Args: { p_auth_user_ids: string[] }
        Returns: string[]
      }
      capability_realtime_membership_bind: {
        Args: {
          p_auth_user_id: string
          p_expires_at: string
          p_token_hash: string
        }
        Returns: Json
      }
      capability_realtime_memberships_prune: { Args: never; Returns: number }
      capability_runtime_set: {
        Args: { p_private_realtime_enabled: boolean; p_writes_enabled: boolean }
        Returns: Json
      }
      capability_runtime_state: { Args: never; Returns: Json }
      capability_session_open: {
        Args: { p_after_seq?: number; p_limit?: number; p_token_hash: string }
        Returns: Json
      }
      capability_updates_append: {
        Args: {
          p_expected_encryption_version: number
          p_token_hash: string
          p_updates: Json
        }
        Returns: Json
      }
      capability_writes_acquire: { Args: never; Returns: boolean }
      capability_writes_enabled: { Args: never; Returns: boolean }
      legacy_share_rotate: {
        Args: { p_slug: string; p_token: string }
        Returns: boolean
      }
      realtime_capability_allows: {
        Args: { p_auth_user_id: string; p_topic: string; p_write: boolean }
        Returns: boolean
      }
    }
    Enums: {
      note_capability_scope: "owner" | "edit" | "view"
      note_sync_status: "legacy" | "active" | "read_only_quarantine" | "deleted"
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
    Enums: {
      note_capability_scope: ["owner", "edit", "view"],
      note_sync_status: ["legacy", "active", "read_only_quarantine", "deleted"],
    },
  },
} as const
