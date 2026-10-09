import { describe, expect, it, vi } from "vitest";
import {
  createRealtimeEdgeApi,
  realtimeHubConfig,
  realtimeSyncFeatureEnabled,
} from "../client-sync";

describe("plain-note realtime client gate and Edge API", () => {
  it("is off unless the feature flag and both capability gates are explicitly enabled", () => {
    expect(realtimeSyncFeatureEnabled({
      VITE_CAPABILITY_ROUTES_ENABLED: "true",
      VITE_CAPABILITY_AUTH_ENABLED: "true",
    })).toBe(false);
    expect(realtimeSyncFeatureEnabled({
      VITE_REALTIME_HUB_SYNC_ENABLED: "true",
      VITE_CAPABILITY_ROUTES_ENABLED: "true",
      VITE_CAPABILITY_AUTH_ENABLED: "false",
    })).toBe(false);
    expect(realtimeSyncFeatureEnabled({
      VITE_REALTIME_HUB_SYNC_ENABLED: "true",
      VITE_CAPABILITY_ROUTES_ENABLED: "true",
      VITE_CAPABILITY_AUTH_ENABLED: "true",
    })).toBe(true);
  });

  it("accepts a loopback WS test hub and rejects non-loopback plaintext WS", () => {
    expect(realtimeHubConfig({
      VITE_REALTIME_HUB_ID: "hub_test_1",
      VITE_REALTIME_HUB_URL: "ws://127.0.0.1:8787",
    })).toEqual({ hubId: "hub_test_1", hubUrl: "ws://127.0.0.1:8787/" });
    expect(realtimeHubConfig({
      VITE_REALTIME_HUB_ID: "hub_test_1",
      VITE_REALTIME_HUB_URL: "ws://hub.example.invalid",
    })).toBeNull();
  });

  it("sends a renewal session_id in the POST body, not in a URL or query string", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ticket: "test-ticket",
      roomId: "room_test_01",
      write_mac_key: "A".repeat(43),
      relay_key: "A".repeat(43),
      relay_key_kid: "relay-test-v1",
      noteId: "00000000-0000-4000-8000-000000000001",
      revision: 1,
      generation: 4,
      permissionEpoch: 7,
      ydocState: "",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const authSource = { accessTokenFor: vi.fn(async () => "fake-local-token") };
    const api = createRealtimeEdgeApi({
      baseUrl: "http://127.0.0.1:54321",
      fetcher: fetcher as typeof fetch,
      authSource,
    });

    await api.issueTicket("random-e2e-note", "session-id-123");

    expect(authSource.accessTokenFor).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/functions/v1/note-session");
    expect(new URL(url).search).toBe("");
    expect(JSON.parse(String(init.body))).toMatchObject({
      action: "realtime-ticket",
      slug: "random-e2e-note",
      session_id: "session-id-123",
    });
    expect(init.credentials).toBe("omit");
    expect((init.headers as Record<string, string>)["X-Snote-Auth"]).toBe("fake-local-token");
  });

  it("rejects a ticket response that has no relay_key", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ticket: "test-ticket",
      roomId: "room_test_01",
      relay_key_kid: "relay-test-v1",
      write_mac_key: "A".repeat(43),
      noteId: "00000000-0000-4000-8000-000000000001",
      revision: 1,
      generation: 4,
      permissionEpoch: 7,
      ydocState: "",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const api = createRealtimeEdgeApi({
      baseUrl: "http://127.0.0.1:54321",
      fetcher: fetcher as typeof fetch,
      authSource: { accessTokenFor: vi.fn(async () => "fake-local-token") },
    });

    await expect(api.issueTicket("random-e2e-note", "session-id-123"))
      .rejects.toThrow("invalid realtime ticket response");
  });
});
