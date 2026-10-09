import { describe, expect, it, vi } from "vitest";
import {
  createRealtimeEdgeApi,
  realtimeHubConfig,
  realtimeHubConfigForTicket,
  prepareRealtimeNoteSafely,
  realtimeSyncFeatureEnabled,
  type RealtimeTicketBundle,
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
    const legacyConfig = realtimeHubConfig({
      VITE_REALTIME_HUB_ID: "hub_test_1",
      VITE_REALTIME_HUB_URL: "ws://127.0.0.1:8787",
    });
    expect(legacyConfig).toEqual({ hubId: "hub_test_1", hubUrl: "ws://127.0.0.1:8787/" });
    expect(realtimeHubConfigForTicket(legacyConfig!, undefined)).toEqual(legacyConfig);
    expect(realtimeHubConfig({
      VITE_REALTIME_HUB_ID: "hub_test_1",
      VITE_REALTIME_HUB_URL: "ws://hub.example.invalid",
    })).toBeNull();
  });

  it("maps a signed ticket hub_id to its configured TLS WebSocket URL", () => {
    const config = realtimeHubConfig({
      VITE_REALTIME_HUBS_JSON: JSON.stringify({
        rt1: "wss://rt1.example.test",
        rt2: "wss://rt2.example.test/realtime",
      }),
    });
    expect(config).toMatchObject({
      hubId: "rt1",
      hubUrl: "wss://rt1.example.test/",
      hubUrls: {
        rt1: "wss://rt1.example.test/",
        rt2: "wss://rt2.example.test/realtime",
      },
    });
    expect(realtimeHubConfigForTicket(config!, "rt2")).toMatchObject({
      hubId: "rt2",
      hubUrl: "wss://rt2.example.test/realtime",
    });
    expect(() => realtimeHubConfigForTicket(config!, undefined)).toThrow(/hub is missing/u);
    expect(() => realtimeHubConfigForTicket(config!, "rt3")).toThrow(/invalid realtime ticket hub/u);
    expect(realtimeHubConfig({
      VITE_REALTIME_HUBS_JSON: JSON.stringify({ rt1: "wss://rt1.example.test", rt2: "ws://rt2.example.test" }),
    })).toBeNull();
  });

  it("rejects a routed hub_id absent from the build map and safely falls back to slow sync", async () => {
    const config = realtimeHubConfig({
      VITE_REALTIME_HUBS_JSON: JSON.stringify({ rt1: "wss://rt1.example.test" }),
    });
    expect(() => realtimeHubConfigForTicket(config!, "rt2"))
      .toThrow(/realtime ticket hub URL is not configured/u);
    const ticket = {
      ticket: "signed-by-test-edge",
      roomId: "room_test_01",
      write_mac_key: "A".repeat(43),
      relay_key: "A".repeat(43),
      relay_key_kid: "relay-test-v1",
      noteId: "00000000-0000-4000-8000-000000000001",
      revision: 1,
      generation: 1,
      permissionEpoch: 1,
      ydocState: "",
      hub_id: "rt2",
      assignment_epoch: 1,
      topology_epoch: 1,
    } satisfies RealtimeTicketBundle;
    const result = await prepareRealtimeNoteSafely("random-e2e-note", {
      config,
      pinnedKeys: { ticketAndProbe: {}, savedAck: {} },
      api: {
        issueTicket: async () => ticket,
        casSave: async () => { throw new Error("unexpected CAS save"); },
      },
    });
    expect(result).toEqual({ status: "fallback", reason: "unavailable" });
  });

  it("sends a renewal session_id in the POST body, not in a URL or query string", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ticket: "test-ticket",
      roomId: "room_test_01",
      hub_id: "rt2",
      assignment_epoch: 4,
      topology_epoch: 9,
      hub_url: "wss://untrusted-edge-url.example.invalid",
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

    const ticket = await api.issueTicket("random-e2e-note", "session-id-123");
    expect(ticket).toMatchObject({ hub_id: "rt2", assignment_epoch: 4, topology_epoch: 9 });
    expect(ticket).not.toHaveProperty("hub_url");

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

  it("rejects unknown hub IDs from Edge instead of accepting a response URL", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ticket: "test-ticket",
      roomId: "room_test_01",
      hub_id: "rt3",
      assignment_epoch: 4,
      topology_epoch: 9,
      hub_url: "wss://attacker.example.invalid",
      write_mac_key: "A".repeat(43),
      relay_key: "A".repeat(43),
      relay_key_kid: "relay-test-v1",
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
      .rejects.toThrow("invalid realtime ticket hub");
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

  it("sends a hub-unreachable report with the failed ticket and session in the authenticated body", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: "hub-change", hub_id: "rt2" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const api = createRealtimeEdgeApi({
      baseUrl: "http://127.0.0.1:54321",
      fetcher: fetcher as typeof fetch,
      authSource: { accessTokenFor: vi.fn(async () => "fake-local-token") },
    });
    await expect(api.reportHubUnreachable?.("random-e2e-note", "session-id-123", "signed-ticket"))
      .resolves.toBe("hub-change");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).search).toBe("");
    expect(JSON.parse(String(init.body))).toMatchObject({
      action: "realtime-hub-report",
      slug: "random-e2e-note",
      session_id: "session-id-123",
      ticket: "signed-ticket",
      report: "hub_unreachable",
    });
  });
});
