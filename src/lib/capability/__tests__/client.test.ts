import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityAuthSource } from "../auth";
import {
  CapabilityApiError,
  createCapabilityApi,
  type NoteSessionBase,
  type PollingNoteSession,
  type PrivateRealtimeNoteSession,
} from "../client";

const env = import.meta.env as Record<string, unknown>;

const TOKEN = "b".repeat(43);
const AUTH_TOKEN = "managed-auth-token";
const NOTE_ID = "00000000-0000-4000-8000-000000000001";

const BASE_SESSION: NoteSessionBase = {
  noteId: NOTE_ID,
  slug: "daily",
  scope: "owner",
  realtimeTopic: `note:${NOTE_ID}`,
  generation: 1,
  syncStatus: "active",
  currentSequence: 0,
  payloadLimitBytes: 4_194_304,
  checkpointSequence: 0,
  checkpointVersion: null,
  checkpointPayload: null,
  checkpointEncryptionVersion: null,
  missingUpdates: [],
  encryption: {
    enabled: false,
    version: 0,
    salt: null,
    check: null,
    iterations: 600_000,
  },
};

function privateSession(
  overrides: Partial<PrivateRealtimeNoteSession> = {},
): PrivateRealtimeNoteSession {
  return {
    ...BASE_SESSION,
    syncTransport: "private-realtime",
    realtimeToken: "header.payload.signature",
    realtimeExpiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function pollingSession(
  overrides: Partial<PollingNoteSession> = {},
): PollingNoteSession {
  return {
    ...BASE_SESSION,
    syncTransport: "polling",
    realtimeToken: null,
    realtimeExpiresAt: null,
    ...overrides,
  };
}

function authSource(
  ...tokens: Array<string | null>
): CapabilityAuthSource & {
  accessTokenFor: ReturnType<typeof vi.fn<CapabilityAuthSource["accessTokenFor"]>>;
} {
  const accessTokenFor = vi.fn<CapabilityAuthSource["accessTokenFor"]>();
  for (const token of tokens) accessTokenFor.mockResolvedValueOnce(token);
  accessTokenFor.mockResolvedValue(null);
  return { accessTokenFor };
}

function apiWithSession(
  value: unknown,
  source = authSource(null),
) {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ session: value }));
  return {
    api: createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: source,
    }),
    fetcher,
    source,
  };
}

const LEGACY_IMPORT = {
  slug: "daily",
  checkpointId: "a".repeat(64),
  payload: "AQID",
  isEncrypted: false,
  salt: null,
  check: null,
  iterations: null,
};

describe("capability API client", () => {
  let previousRoutesFlag: unknown;

  beforeEach(() => {
    previousRoutesFlag = env.VITE_CAPABILITY_ROUTES_ENABLED;
    env.VITE_CAPABILITY_ROUTES_ENABLED = "true";
  });

  afterEach(() => {
    env.VITE_CAPABILITY_ROUTES_ENABLED = previousRoutesFlag;
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["false", "false"],
    ["TRUE", "TRUE"],
    ["1", "1"],
  ])("fails closed without fetching gated Edge names when the routes canary is %s", async (
    _label,
    flag,
  ) => {
    env.VITE_CAPABILITY_ROUTES_ENABLED = flag;
    const source = authSource("must-not-mint");
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("capability Edge must not be fetched while canary is off");
    });
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: source,
    });

    await expect(api.createNote("daily", TOKEN)).rejects.toThrow("capability API unavailable");
    await expect(api.importLegacyNote(LEGACY_IMPORT, TOKEN)).rejects.toThrow(
      "capability API unavailable",
    );
    await expect(api.convertLegacyNote(LEGACY_IMPORT, TOKEN)).rejects.toThrow(
      "capability API unavailable",
    );
    await expect(api.upsertPlainNote({
      slug: "daily",
      ydocState: "YQ",
      content: "hello",
      charCount: 5,
      tags: [],
      isEncrypted: false,
      salt: null,
      check: null,
      iterations: null,
    })).rejects.toThrow("capability API unavailable");
    await expect(api.disableSecureNote({
      slug: "daily",
      ydocState: "YQ",
      content: "hello",
      charCount: 5,
      tags: [],
      isEncrypted: false,
      salt: null,
      check: null,
      iterations: null,
    }, TOKEN)).rejects.toThrow("capability API unavailable");
    await expect(api.openSession(TOKEN)).rejects.toThrow("capability API unavailable");
    await expect(api.sync(TOKEN, {
      updates: [],
      expectedEncryptionVersion: 0,
      afterSequence: 0,
    })).rejects.toThrow("capability API unavailable");
    await expect(api.manage(TOKEN, { action: "rotate" })).rejects.toThrow(
      "capability API unavailable",
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(source.accessTokenFor).not.toHaveBeenCalled();
    expect(JSON.stringify(fetcher.mock.calls)).not.toMatch(/note-session|note-sync|note-manage/);
  });

  it("keeps capability and managed Auth in separate headers only", async () => {
    const source = authSource(AUTH_TOKEN);
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://project.supabase.co/functions/v1/note-session",
      );
      expect(init).toMatchObject({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          "X-Snote-Auth": AUTH_TOKEN,
        },
        cache: "no-store",
        credentials: "omit",
        keepalive: false,
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        action: "create",
        slug: "daily",
      });
      expect(String(input)).not.toContain(TOKEN);
      expect(String(input)).not.toContain(AUTH_TOKEN);
      expect(String(init?.body)).not.toContain(TOKEN);
      expect(String(init?.body)).not.toContain(AUTH_TOKEN);
      return Response.json({
        session: privateSession(),
        capabilities: { owner: TOKEN },
      }, { status: 200 });
    });
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: source,
    });

    const created = await api.createNote("daily", TOKEN);

    expect(created.capabilities.owner).toBe(TOKEN);
    expect(created.capabilities.edit).toBeUndefined();
    expect(created.capabilities.view).toBeUndefined();
    expect(source.accessTokenFor).toHaveBeenCalledWith(TOKEN, "ensure");
  });

  it("sends only the capability header when managed Auth is missing and accepts polling", async () => {
    const source = authSource(null);
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      });
      return Response.json({ session: pollingSession() });
    });
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: source,
    });

    const opened = await api.openSession(TOKEN);

    expect(opened.syncTransport).toBe("polling");
    expect(opened.realtimeToken).toBeNull();
  });

  it("fails soft without logging when managed Auth rejects", async () => {
    const rejection = new Error("managed auth unavailable");
    const source = {
      accessTokenFor: vi.fn<CapabilityAuthSource["accessTokenFor"]>()
        .mockRejectedValue(rejection),
    };
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      });
      return Response.json({ session: pollingSession() });
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: source,
    });

    try {
      const opened = await api.openSession(TOKEN);

      expect(opened.syncTransport).toBe("polling");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([
    [401, null, "unauthorized", "unauthorized"],
    [409, null, "version conflict", "version_conflict"],
    [409, null, "version conflict", "append_encryption_conflict"],
    [409, null, "version conflict", "checkpoint_encryption_conflict"],
    [409, null, "version conflict", "checkpoint_version_conflict"],
    [429, "3600", "capacity temporarily exceeded", "rate_limited"],
    [409, null, "note is read only", "quota_exceeded"],
    [503, null, "temporarily unavailable", "writes_disabled"],
  ])("preserves HTTP status and Retry-After for a %i capability failure", async (
    status,
    retryAfter,
    message,
    code,
  ) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(
      { error: message, code },
      {
        status,
        headers: retryAfter ? { "Retry-After": retryAfter } : undefined,
      },
    ));
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: authSource(null),
    });

    await expect(api.openSession(TOKEN)).rejects.toMatchObject({
      name: "CapabilityApiError",
      message,
      status,
      retryAfterMs: retryAfter ? Number(retryAfter) * 1_000 : null,
      code,
    } satisfies Partial<CapabilityApiError>);
  });

  it.each([
    ["private realtime", privateSession()],
    ["polling", pollingSession()],
  ])("validates the %s session variant", async (_label, value) => {
    const { api } = apiWithSession(value);

    await expect(api.openSession(TOKEN)).resolves.toEqual(value);
  });

  it.each([
    [
      "unknown transport",
      { ...privateSession(), syncTransport: "websocket" },
    ],
    [
      "private realtime with a null token",
      { ...privateSession(), realtimeToken: null },
    ],
    [
      "private realtime with a null expiry",
      { ...privateSession(), realtimeExpiresAt: null },
    ],
    [
      "private realtime with an empty token",
      { ...privateSession(), realtimeToken: "" },
    ],
    [
      "private realtime with an overlong token",
      { ...privateSession(), realtimeToken: "a".repeat(8193) },
    ],
    [
      "private realtime with an empty expiry",
      { ...privateSession(), realtimeExpiresAt: "" },
    ],
    [
      "private realtime with a non-ISO legacy expiry",
      {
        ...privateSession(),
        realtimeExpiresAt: "January 1, 2099 00:00:00 UTC",
      },
    ],
    [
      "private realtime with a timezone-less expiry",
      { ...privateSession(), realtimeExpiresAt: "2099-01-01T00:00:00.000" },
    ],
    [
      "private realtime with an impossible calendar expiry",
      { ...privateSession(), realtimeExpiresAt: "2023-02-29T00:00:00.000Z" },
    ],
    [
      "private realtime with an overlong expiry",
      { ...privateSession(), realtimeExpiresAt: "2099-01-01T00:00:00.0000Z" },
    ],
    [
      "polling with a token",
      { ...pollingSession(), realtimeToken: "header.payload.signature" },
    ],
    [
      "polling with an expiry",
      { ...pollingSession(), realtimeExpiresAt: "2099-01-01T00:00:00.000Z" },
    ],
  ])("rejects %s", async (_label, value) => {
    const { api } = apiWithSession(value);

    await expect(api.openSession(TOKEN)).rejects.toThrow("invalid note session");
  });

  it.each([
    "noteId",
    "slug",
    "scope",
    "realtimeTopic",
    "generation",
    "syncStatus",
    "currentSequence",
    "payloadLimitBytes",
    "checkpointSequence",
    "checkpointVersion",
    "checkpointPayload",
    "checkpointEncryptionVersion",
    "missingUpdates",
    "encryption",
  ] as const)("requires the durable %s field", async (field) => {
    const value: Record<string, unknown> = { ...privateSession() };
    delete value[field];
    const { api } = apiWithSession(value);

    await expect(api.openSession(TOKEN)).rejects.toThrow("invalid note session");
  });

  it.each([
    ["note UUID", { noteId: "not-a-uuid" }],
    ["slug", { slug: "not a slug" }],
    ["reserved lowercase slug", { slug: "note" }],
    ["reserved mixed-case privacy slug", { slug: "Privacy" }],
    ["reserved uppercase share slug", { slug: "S" }],
    ["non-string slug", { slug: 123 }],
    ["scope", { scope: "admin" }],
    ["exact realtime topic", { realtimeTopic: "note:someone-else" }],
    ["generation", { generation: 0 }],
    ["sync status", { syncStatus: "paused" }],
    ["current sequence", { currentSequence: -1 }],
    ["payload limit", { payloadLimitBytes: 4_194_305 }],
    ["checkpoint sequence bounds", { checkpointSequence: 2, currentSequence: 1 }],
    [
      "checkpoint version tuple",
      {
        checkpointSequence: 1,
        currentSequence: 1,
        checkpointVersion: 1,
        checkpointPayload: null,
        checkpointEncryptionVersion: 0,
      },
    ],
    [
      "checkpoint payload decoding",
      {
        checkpointSequence: 1,
        currentSequence: 1,
        checkpointVersion: 1,
        checkpointPayload: "***",
        checkpointEncryptionVersion: 0,
      },
    ],
    [
      "checkpoint payload size",
      {
        currentSequence: 1,
        payloadLimitBytes: 1,
        checkpointSequence: 1,
        checkpointVersion: 1,
        checkpointPayload: "AQI",
        checkpointEncryptionVersion: 0,
      },
    ],
    [
      "encryption metadata",
      {
        encryption: {
          enabled: true,
          version: 1,
          salt: null,
          check: null,
          iterations: 600_000,
        },
      },
    ],
    [
      "encryption version",
      {
        encryption: {
          enabled: false,
          version: -1,
          salt: null,
          check: null,
          iterations: 600_000,
        },
      },
    ],
    [
      "encryption iterations",
      {
        encryption: {
          enabled: false,
          version: 0,
          salt: null,
          check: null,
          iterations: 0,
        },
      },
    ],
    [
      "update IDs",
      {
        currentSequence: 1,
        missingUpdates: [
          {
            updateId: "not-a-hash",
            payload: "AQ",
            sequence: 1,
            encryptionVersion: 0,
          },
        ],
      },
    ],
    [
      "update sequence bounds",
      {
        currentSequence: 1,
        missingUpdates: [
          {
            updateId: "1".repeat(64),
            payload: "AQ",
            sequence: 2,
            encryptionVersion: 0,
          },
        ],
      },
    ],
    [
      "update encryption version",
      {
        currentSequence: 1,
        missingUpdates: [
          {
            updateId: "1".repeat(64),
            payload: "AQ",
            sequence: 1,
            encryptionVersion: -1,
          },
        ],
      },
    ],
    [
      "unique update IDs",
      {
        currentSequence: 2,
        missingUpdates: [
          {
            updateId: "1".repeat(64),
            payload: "AQ",
            sequence: 1,
            encryptionVersion: 0,
          },
          {
            updateId: "1".repeat(64),
            payload: "Ag",
            sequence: 2,
            encryptionVersion: 0,
          },
        ],
      },
    ],
    [
      "unique update sequences",
      {
        currentSequence: 2,
        missingUpdates: [
          {
            updateId: "1".repeat(64),
            payload: "AQ",
            sequence: 1,
            encryptionVersion: 0,
          },
          {
            updateId: "2".repeat(64),
            payload: "Ag",
            sequence: 1,
            encryptionVersion: 0,
          },
        ],
      },
    ],
    [
      "update payload decoding",
      {
        currentSequence: 1,
        missingUpdates: [
          {
            updateId: "1".repeat(64),
            payload: "***",
            sequence: 1,
            encryptionVersion: 0,
          },
        ],
      },
    ],
    [
      "update payload size",
      {
        currentSequence: 1,
        payloadLimitBytes: 1,
        missingUpdates: [
          {
            updateId: "1".repeat(64),
            payload: "AQI",
            sequence: 1,
            encryptionVersion: 0,
          },
        ],
      },
    ],
  ])("validates %s", async (_label, overrides) => {
    const { api } = apiWithSession(privateSession(
      overrides as Partial<PrivateRealtimeNoteSession>,
    ));

    await expect(api.openSession(TOKEN)).rejects.toThrow("invalid note session");
  });

  it("obtains current Auth for each page and replaces private transport with later polling", async () => {
    const source = authSource("auth-page-one", "auth-page-two");
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.afterSequence === 0) {
        expect(init?.headers).toMatchObject({ "X-Snote-Auth": "auth-page-one" });
        return Response.json({
          session: privateSession({
            currentSequence: 2,
            missingUpdates: [
              {
                updateId: "1".repeat(64),
                payload: "AQ",
                sequence: 1,
                encryptionVersion: 0,
              },
            ],
          }),
        });
      }
      expect(body.afterSequence).toBe(1);
      expect(init?.headers).toMatchObject({ "X-Snote-Auth": "auth-page-two" });
      return Response.json({
        session: pollingSession({
          currentSequence: 2,
          missingUpdates: [
            {
              updateId: "2".repeat(64),
              payload: "Ag",
              sequence: 2,
              encryptionVersion: 0,
            },
          ],
        }),
      });
    });
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: source,
    });

    const opened = await api.openSession(TOKEN);

    expect(source.accessTokenFor).toHaveBeenNthCalledWith(1, TOKEN, "ensure");
    expect(source.accessTokenFor).toHaveBeenNthCalledWith(2, TOKEN, "ensure");
    expect(opened.missingUpdates.map((update) => update.sequence)).toEqual([1, 2]);
    expect(opened.syncTransport).toBe("polling");
    expect(opened.realtimeToken).toBeNull();
    expect(opened.realtimeExpiresAt).toBeNull();
  });

  it.each([
    [
      "note ID",
      {
        noteId: "00000000-0000-4000-8000-000000000002",
        realtimeTopic: "note:00000000-0000-4000-8000-000000000002",
      },
    ],
    ["slug", { slug: "changed" }],
    ["scope", { scope: "view" }],
    ["generation", { generation: 2 }],
    [
      "encryption version",
      {
        encryption: {
          ...BASE_SESSION.encryption,
          version: 1,
        },
      },
    ],
  ])("rejects a pagination %s mismatch", async (_label, overrides) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        session: privateSession({
          currentSequence: 2,
          missingUpdates: [{
            updateId: "1".repeat(64),
            payload: "AQ",
            sequence: 1,
            encryptionVersion: 0,
          }],
        }),
      }))
      .mockResolvedValueOnce(Response.json({
        session: pollingSession({
          currentSequence: 2,
          missingUpdates: [{
            updateId: "2".repeat(64),
            payload: "Ag",
            sequence: 2,
            encryptionVersion: 0,
          }],
          ...overrides as Partial<PollingNoteSession>,
        }),
      }));
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: authSource(null, null),
    });

    await expect(api.openSession(TOKEN)).rejects.toThrow("note session changed");
  });

  it("uses cached-only managed Auth for keepalive sync", async () => {
    const source = authSource(AUTH_TOKEN);
    const update = {
      updateId: "4".repeat(64),
      payload: "BA",
      encryptionVersion: 0,
    };
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.keepalive).toBe(true);
      expect(init?.headers).toMatchObject({ "X-Snote-Auth": AUTH_TOKEN });
      return Response.json({
        acknowledgements: [{ updateId: update.updateId, sequence: 4 }],
        session: privateSession({ currentSequence: 4 }),
      });
    });
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: source,
    });

    await api.sync(TOKEN, {
      updates: [update],
      expectedEncryptionVersion: 0,
      afterSequence: 3,
    }, true);

    expect(source.accessTokenFor).toHaveBeenCalledWith(TOKEN, "cached-only");
  });

  it.each([
    ["empty", ""],
    ["overlong", "a".repeat(8193)],
  ])("omits an %s managed Auth token", async (_label, managedToken) => {
    const source = authSource(managedToken);
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      });
      return Response.json({ session: pollingSession() });
    });
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: source,
    });

    await api.openSession(TOKEN);
  });

  it("routes create, import, convert, open, sync, and manage through managed Auth", async () => {
    const source = authSource(
      "auth-create",
      "auth-import",
      "auth-convert",
      "auth-open",
      "auth-sync",
      "auth-manage",
    );
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const name = String(input).split("/").at(-1);
      const call = fetcher.mock.calls.length;
      if (name === "note-sync") {
        return Response.json({
          acknowledgements: [],
          session: pollingSession(),
        });
      }
      if (name === "note-manage") return Response.json({ ok: true });
      if (call <= 3) {
        return Response.json({
          session: pollingSession(),
          capabilities: { owner: TOKEN },
        });
      }
      return Response.json({ session: pollingSession() });
    });
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: source,
    });

    await api.createNote("daily", TOKEN);
    await api.importLegacyNote({
      slug: "daily",
      checkpointId: "a".repeat(64),
      payload: "AQID",
      isEncrypted: false,
      salt: null,
      check: null,
      iterations: null,
    }, TOKEN);
    await api.convertLegacyNote({
      slug: "daily",
      checkpointId: "a".repeat(64),
      payload: "AQID",
      isEncrypted: false,
      salt: null,
      check: null,
      iterations: null,
    }, TOKEN);
    await api.openSession(TOKEN);
    await api.sync(TOKEN, {
      updates: [],
      expectedEncryptionVersion: 0,
      afterSequence: 0,
    });
    await api.manage(TOKEN, { action: "rotate" });

    expect(source.accessTokenFor.mock.calls).toEqual([
      [TOKEN, "ensure"],
      [TOKEN, "ensure"],
      [TOKEN, "ensure"],
      [TOKEN, "ensure"],
      [TOKEN, "ensure"],
      [TOKEN, "ensure"],
    ]);
    expect(fetcher.mock.calls.map(([, init]) => init?.headers)).toEqual([
      expect.objectContaining({ "X-Snote-Auth": "auth-create" }),
      expect.objectContaining({ "X-Snote-Auth": "auth-import" }),
      expect.objectContaining({ "X-Snote-Auth": "auth-convert" }),
      expect.objectContaining({ "X-Snote-Auth": "auth-open" }),
      expect.objectContaining({ "X-Snote-Auth": "auth-sync" }),
      expect.objectContaining({ "X-Snote-Auth": "auth-manage" }),
    ]);
  });

  it("imports an initial legacy checkpoint and preserves returned capabilities", async () => {
    const initial = {
      slug: "daily-copy",
      checkpointId: "a".repeat(64),
      payload: "AQID",
      isEncrypted: false,
      salt: null,
      check: null,
      iterations: null,
    };
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
      expect(JSON.parse(String(init?.body))).toEqual({
        action: "import-legacy",
        ...initial,
      });
      return Response.json({
        session: privateSession({
          slug: "daily-copy",
          checkpointVersion: 1,
          checkpointPayload: "AQID",
          checkpointEncryptionVersion: 0,
        }),
        capabilities: {
          owner: TOKEN,
          edit: "c".repeat(43),
          view: "d".repeat(43),
        },
      }, { status: 201 });
    });
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: authSource(null),
    });

    const imported = await api.importLegacyNote(initial, TOKEN);

    expect(imported.capabilities.owner).toBe(TOKEN);
    expect(imported.session.checkpointPayload).toBe("AQID");
  });

  it("converts an existing legacy note through note-session convert-legacy", async () => {
    const initial = {
      slug: "daily",
      checkpointId: "a".repeat(64),
      payload: "AQID",
      isEncrypted: false,
      salt: null,
      check: null,
      iterations: null,
    };
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
      expect(JSON.parse(String(init?.body))).toEqual({
        action: "convert-legacy",
        ...initial,
      });
      return Response.json({
        session: privateSession({
          slug: "daily",
          checkpointVersion: 1,
          checkpointPayload: "AQID",
          checkpointEncryptionVersion: 0,
        }),
        capabilities: {
          owner: TOKEN,
          edit: "c".repeat(43),
          view: "d".repeat(43),
        },
      }, { status: 201 });
    });
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: authSource(null),
    });

    const converted = await api.convertLegacyNote(initial, TOKEN);

    expect(converted.capabilities.owner).toBe(TOKEN);
    expect(converted.session.checkpointPayload).toBe("AQID");
  });

  it("upserts a plain note without a capability bearer", async () => {
    const source = authSource("must-not-mint");
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://project.supabase.co/functions/v1/note-session",
      );
      expect(init).toMatchObject({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: false,
      });
      expect(init?.headers).not.toHaveProperty("Authorization");
      expect(init?.headers).not.toHaveProperty("X-Snote-Auth");
      expect(JSON.parse(String(init?.body))).toEqual({
        action: "plain-upsert",
        slug: "daily",
        ydocState: "YQ",
        content: "hello",
        charCount: 5,
        tags: [],
        isEncrypted: false,
        salt: null,
        check: null,
        iterations: null,
      });
      return Response.json({
        status: "ok",
        noteId: NOTE_ID,
        created: true,
      }, { status: 201 });
    });
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: source,
    });

    await expect(api.upsertPlainNote({
      slug: "daily",
      ydocState: "YQ",
      content: "hello",
      charCount: 5,
      tags: [],
      isEncrypted: false,
      salt: null,
      check: null,
      iterations: null,
    })).resolves.toEqual({ noteId: NOTE_ID, created: true });
    expect(source.accessTokenFor).not.toHaveBeenCalled();
  });

  it("disables a secure note with the owner bearer only", async () => {
    const source = authSource(AUTH_TOKEN);
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        "X-Snote-Auth": AUTH_TOKEN,
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        action: "disable-secure",
        slug: "daily",
      });
      expect(String(init?.body)).not.toContain(TOKEN);
      return Response.json({
        status: "ok",
        noteId: NOTE_ID,
        recovered: false,
      });
    });
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: source,
    });

    await expect(api.disableSecureNote({
      slug: "daily",
      ydocState: "YQ",
      content: "hello",
      charCount: 5,
      tags: [],
      isEncrypted: false,
      salt: null,
      check: null,
      iterations: null,
    }, TOKEN)).resolves.toEqual({ noteId: NOTE_ID, recovered: false });
  });

  it("syncs an idempotent update batch without serializing either secret", async () => {
    const update = {
      updateId: "4".repeat(64),
      payload: "BA",
      encryptionVersion: 0,
    };
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).not.toContain(TOKEN);
      expect(String(input)).not.toContain(AUTH_TOKEN);
      expect(String(init?.body)).not.toContain(TOKEN);
      expect(String(init?.body)).not.toContain(AUTH_TOKEN);
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        "X-Snote-Auth": AUTH_TOKEN,
      });
      return Response.json({
        acknowledgements: [{ updateId: update.updateId, sequence: 4 }],
        session: privateSession({ currentSequence: 4 }),
      });
    });
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: authSource(AUTH_TOKEN),
    });

    const response = await api.sync(TOKEN, {
      updates: [update],
      expectedEncryptionVersion: 0,
      afterSequence: 3,
    });

    expect(response.acknowledgements).toEqual([
      { updateId: update.updateId, sequence: 4 },
    ]);
  });

  it("rejects acknowledgements that are not bounded update receipts", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      acknowledgements: [{ updateId: "not-a-hash", sequence: -1 }],
      session: pollingSession(),
    }));
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: authSource(null),
    });

    await expect(api.sync(TOKEN, {
      updates: [],
      expectedEncryptionVersion: 0,
      afterSequence: 0,
    })).rejects.toThrow("invalid acknowledgements");
  });

  it("preserves capability input and response validation", async () => {
    const source = authSource(null);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      session: pollingSession(),
      capabilities: { owner: "c".repeat(43) },
    }));
    const api = createCapabilityApi({
      baseUrl: "https://project.supabase.co",
      fetcher,
      authSource: source,
    });

    await expect(api.openSession("not-a-capability")).rejects.toThrow(
      "invalid capability",
    );
    expect(source.accessTokenFor).not.toHaveBeenCalled();
    await expect(api.createNote("daily", TOKEN)).rejects.toThrow(
      "invalid capabilities",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
