import { createClient } from "https://esm.sh/@supabase/supabase-js@2.104.1";
import { loadRealtimeSigningConfig } from "../_shared/realtime-edge.ts";
import {
  createRealtimeMonitorHandler,
  type MonitorRpc,
  type MonitorRpcName,
} from "./monitor.ts";
import { unavailableHubBudgetMetricsProvider } from "../note-session/realtime-hub-edge.ts";

function createRpc(): MonitorRpc | null {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) return null;
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return async (name: MonitorRpcName, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(name as never, args as never);
    return { data, error };
  };
}

const handler = createRealtimeMonitorHandler({
  // Syringa provisions this same secret independently in Supabase Vault and
  // the Edge secret store. Never log or persist its value in this repository.
  secret: Deno.env.get("SNOTE_REALTIME_MONITOR_SECRET") ?? null,
  routingEnabled: () => Deno.env.get("SNOTE_REALTIME_HUB_ROUTING_ENABLED") === "true",
  createRpc: async () => createRpc(),
  createMonitorDependencies: (rpc) => ({
    routingEnabled: Deno.env.get("SNOTE_REALTIME_HUB_ROUTING_ENABLED") === "true",
    rpc,
    getSigning: async () => {
      try {
        return await loadRealtimeSigningConfig({
          ticketPrivateJwk: Deno.env.get("SNOTE_REALTIME_TICKET_PRIVATE_JWK") ?? "",
          ticketKid: Deno.env.get("SNOTE_REALTIME_TICKET_KID") ?? "",
          savedAckPrivateJwk: Deno.env.get("SNOTE_REALTIME_SAVED_ACK_PRIVATE_JWK") ?? "",
          savedAckKid: Deno.env.get("SNOTE_REALTIME_SAVED_ACK_KID") ?? "",
          hubId: Deno.env.get("SNOTE_REALTIME_HUB_ID") ?? "",
          assignmentEpoch: Deno.env.get("SNOTE_REALTIME_ASSIGNMENT_EPOCH") ?? "",
          roomHmacKey: Deno.env.get("SNOTE_REALTIME_ROOM_HMAC_KEY") ?? "",
          writeMacMasterKey: Deno.env.get("SNOTE_REALTIME_WRITE_MAC_MASTER_KEY") ?? "",
          relayMasterKey: Deno.env.get("SNOTE_REALTIME_RELAY_MASTER_KEY") ?? "",
          relayKeyKid: Deno.env.get("SNOTE_REALTIME_RELAY_KEY_KID") ?? "",
        });
      } catch {
        return null;
      }
    },
    // There is no live metrics provider in this PR. Keep rt2 fail-closed and
    // never call Cloudflare Analytics; the request-cost guard remains injectable.
    metricsProvider: unavailableHubBudgetMetricsProvider,
    healthUrl: (hubId) => {
      const variable = hubId === "rt1"
        ? "SNOTE_REALTIME_HUB_RT1_HEALTH_URL"
        : "SNOTE_REALTIME_HUB_RT2_HEALTH_URL";
      return Deno.env.get(variable) ?? null;
    },
  }),
});

Deno.serve(handler);
