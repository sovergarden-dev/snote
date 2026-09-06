import { createClient } from "https://esm.sh/@supabase/supabase-js@2.104.1";
import {
  handleLegacyNoteOpen,
  type LegacyNoteLookup,
  type LegacyNoteRow,
} from "./handler.ts";

// HMAC CF-Connecting-IP admission is omitted: this path is SELECT-only and
// has no admission window. Consume RPCs would write. No Turnstile.

function serviceLookup(): LegacyNoteLookup | null {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) return null;

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const visible = (columns: string, slug: string) =>
    client
      .from("notes")
      .select(columns)
      .eq("slug", slug)
      .eq("capability_managed", false)
      .eq("sync_status", "legacy")
      .is("deleted_at", null)
      .maybeSingle();

  return {
    async exists(slug) {
      const { data, error } = await visible("slug", slug);
      if (error) return "unavailable";
      return !!data;
    },
    async open(slug) {
      const { data, error } = await visible(
        "slug, content, ydoc_state, is_encrypted, enc_salt, enc_check, enc_iterations",
        slug,
      );
      if (error) return "unavailable";
      return (data as LegacyNoteRow | null) ?? null;
    },
  };
}

Deno.serve((req) => {
  if (req.method !== "POST") return handleLegacyNoteOpen(req, null);
  return handleLegacyNoteOpen(req, serviceLookup());
});
