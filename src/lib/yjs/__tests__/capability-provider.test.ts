import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  CapabilityYjsProvider,
  type CapabilityRealtimeFactory,
  type CapabilityRealtimeHandle,
} from "../capability-provider";
import { CapabilityOutbox } from "../capability-outbox";
import {
  CapabilityApiError,
  type CapabilityApi,
  type PollingNoteSession,
  type PrivateRealtimeNoteSession,
} from "@/lib/capability/client";
import { capabilityPayloadId, decodeCapabilityPayload } from "@/lib/capability/encoding";

const TOKEN = "e".repeat(43);
const NOTE_ID = "00000000-0000-4000-8000-000000000001";
const root = process.cwd();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function providerSource() {
  return readFileSync(resolve(root, "src/lib/yjs/capability-provider.ts"), "utf8")
    .replace(/\r\n/g, "\n");
}

function baseSession(
  overrides: Partial<PrivateRealtimeNoteSession> = {},
): PrivateRealtimeNoteSession {
  return {
    noteId: NOTE_ID,
    slug: "daily",
    scope: "edit",
    syncTransport: "private-realtime",
    realtimeToken: "header.payload.signature",
    realtimeExpiresAt: "2099-01-01T00:00:00.000Z",
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
    encryption: { enabled: false, version: 0, salt: null, check: null, iterations: 600_000 },
    ...overrides,
  };
}

function pollingSession(
  overrides: Partial<PollingNoteSession> = {},
): PollingNoteSession {
  const {
    syncTransport: _syncTransport,
    realtimeToken: _token,
    realtimeExpiresAt: _expiresAt,
    ...durable
  } = baseSession();
  return {
    ...durable,
    syncTransport: "polling",
    realtimeToken: null,
    realtimeExpiresAt: null,
    ...overrides,
  };
}

function realtimeHarness() {
  const handlers = new Map<string, (message: { payload: unknown }) => void | Promise<void>>();
  const send = vi.fn(async () => "ok");
  const channel = {
    on: vi.fn((_type: string, filter: { event?: string }, handler: (message: { payload: unknown }) => void) => {
      if (filter.event) handlers.set(filter.event, handler);
      return channel;
    }),
    subscribe: vi.fn(async (handler: (status: string) => void | Promise<void>) => {
      await handler("SUBSCRIBED");
      return channel;
    }),
    send,
    unsubscribe: vi.fn(async () => "ok"),
  };
  const dispose = vi.fn(async () => {});
  const factory: CapabilityRealtimeFactory = async () => ({
    channel,
    setAuth: vi.fn(async () => {}),
    dispose,
  });
  return { handlers, send, dispose, factory };
}

function lifecycleRealtimeHarness(events: string[]) {
  const handles: Array<{
    setAuth: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const factory = vi.fn(async (session: PrivateRealtimeNoteSession) => {
    const channel = {
      on: vi.fn(() => channel),
      subscribe: vi.fn(async (handler: (status: string) => void | Promise<void>) => {
        events.push("subscribe");
        await handler("SUBSCRIBED");
        return channel;
      }),
      send: vi.fn(async () => "ok"),
      unsubscribe: vi.fn(async () => "ok"),
    };
    const setAuth = vi.fn(async (token: string) => {
      events.push(`set-auth:${token}`);
    });
    const dispose = vi.fn(async () => {
      events.push(`dispose:${session.realtimeToken}`);
    });
    await setAuth(session.realtimeToken);
    handles.push({ setAuth, dispose });
    return { channel, setAuth, dispose };
  });
  return {
    factory: factory as CapabilityRealtimeFactory,
    handles,
    realtimeFactory: factory,
  };
}

function realtimeHandle(): CapabilityRealtimeHandle {
  const channel = {
    on: vi.fn(() => channel),
    subscribe: vi.fn(async (handler: (status: string) => void | Promise<void>) => {
      await handler("SUBSCRIBED");
      return channel;
    }),
    send: vi.fn(async () => "ok"),
    unsubscribe: vi.fn(async () => "ok"),
  };
  return {
    channel,
    setAuth: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

function controllableRealtimeHarness() {
  const broadcastHandlers = new Map<string, (message: { payload: unknown }) => void | Promise<void>>();
  let statusHandler: ((status: string) => void | Promise<void>) | undefined;
  const channel = {
    on: vi.fn((_type: string, filter: { event?: string }, handler: (message: { payload: unknown }) => void) => {
      if (filter.event) broadcastHandlers.set(filter.event, handler);
      return channel;
    }),
    subscribe: vi.fn(async (handler: (status: string) => void | Promise<void>) => {
      statusHandler = handler;
      return channel;
    }),
    send: vi.fn(async () => "ok"),
    unsubscribe: vi.fn(async () => "ok"),
  };
  const dispose = vi.fn(async () => {});
  const factory: CapabilityRealtimeFactory = async () => ({
    channel,
    setAuth: vi.fn(async () => {}),
    dispose,
  });
  return {
    dispose,
    factory,
    emitStatus: async (status: string) => statusHandler?.(status),
    emitBroadcast: async (event: string, payload: unknown) => broadcastHandlers.get(event)?.({ payload }),
  };
}

type PollingListener = (event: Event) => void;

function pollingEventHarness() {
  let hidden = false;
  const windowListeners = new Map<string, Set<PollingListener>>();
  const documentListeners = new Map<string, Set<PollingListener>>();
  const add = (listeners: Map<string, Set<PollingListener>>, type: string, listener: PollingListener) => {
    const registered = listeners.get(type) ?? new Set<PollingListener>();
    registered.add(listener);
    listeners.set(type, registered);
  };
  const remove = (listeners: Map<string, Set<PollingListener>>, type: string, listener: PollingListener) => {
    listeners.get(type)?.delete(listener);
  };
  const emit = (listeners: Map<string, Set<PollingListener>>, type: string) => {
    for (const listener of listeners.get(type) ?? []) listener(new Event(type));
  };
  const eventTarget = {
    addEventListener: vi.fn((type: string, listener: PollingListener) => add(windowListeners, type, listener)),
    removeEventListener: vi.fn((type: string, listener: PollingListener) => remove(windowListeners, type, listener)),
  } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;
  const documentTarget = {
    get visibilityState() { return hidden ? "hidden" : "visible"; },
    addEventListener: vi.fn((type: string, listener: PollingListener) => add(documentListeners, type, listener)),
    removeEventListener: vi.fn((type: string, listener: PollingListener) => remove(documentListeners, type, listener)),
  } as unknown as Pick<
    Document,
    "addEventListener" | "removeEventListener" | "visibilityState"
  >;
  return {
    eventTarget,
    documentTarget,
    isHidden: () => hidden,
    setHidden: (value: boolean) => { hidden = value; },
    emitWindow: (type: string) => emit(windowListeners, type),
    emitDocument: (type: string) => emit(documentListeners, type),
  };
}

function pollingTimerHarness() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { dueAt: number; handler: () => void }>();
  const nextDueTimer = (target: number) => [...timers.entries()]
    .filter(([, timer]) => timer.dueAt <= target)
    .sort(([, left], [, right]) => left.dueAt - right.dueAt)[0];

  return {
    now: () => now,
    setTimer: ((handler: () => void, timeout = 0) => {
      nextId += 1;
      timers.set(nextId, { dueAt: now + timeout, handler });
      return nextId;
    }) as unknown as typeof window.setTimeout,
    clearTimer: ((timer?: number) => {
      if (timer !== undefined) timers.delete(timer);
    }) as unknown as typeof window.clearTimeout,
    nextDelay: () => {
      const next = nextDueTimer(Number.POSITIVE_INFINITY);
      return next ? next[1].dueAt - now : null;
    },
    async advanceBy(delay: number) {
      const target = now + delay;
      let next = nextDueTimer(target);
      while (next) {
        const [id, timer] = next;
        now = timer.dueAt;
        timers.delete(id);
        timer.handler();
        await Promise.resolve();
        next = nextDueTimer(target);
      }
      now = target;
      await Promise.resolve();
    },
  };
}

function apiHarness(syncImpl?: CapabilityApi["sync"]) {
  return {
    createNote: vi.fn(),
    openSession: vi.fn(async () => baseSession()),
    sync: vi.fn(syncImpl ?? (async (_token, body) => ({
      acknowledgements: body.updates.map((update, index) => ({
        updateId: update.updateId,
        sequence: index + 1,
      })),
      session: baseSession({ currentSequence: body.updates.length }),
    }))),
    manage: vi.fn(),
  } as unknown as CapabilityApi;
}

const testOutboxDatabaseNames = new Set(["snote-capability-provider-test"]);

function testOutbox(databaseName = "snote-capability-provider-test") {
  testOutboxDatabaseNames.add(databaseName);
  return new CapabilityOutbox(databaseName);
}

async function deleteOutboxDatabase(databaseName: string) {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`failed to delete ${databaseName}`));
    request.onblocked = () => reject(new Error(`outbox database remained open: ${databaseName}`));
  });
}

function encode(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

describe("CapabilityYjsProvider", () => {
  beforeEach(async () => {
    await Promise.all([...testOutboxDatabaseNames].map(deleteOutboxDatabase));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all([...testOutboxDatabaseNames].map(deleteOutboxDatabase));
  });

  it("waits for managed platform auth before subscribing to an initial private channel", async () => {
    const events: string[] = [];
    const realtime = lifecycleRealtimeHarness(events);
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      new Y.Doc(),
      {
        api: apiHarness(),
        outbox: new CapabilityOutbox("snote-capability-provider-test"),
        realtimeFactory: realtime.factory,
      },
    );

    await provider.connect({ name: "Tester", color: "#123456" });
    await vi.waitFor(() => expect(events).toEqual([
      "set-auth:header.payload.signature",
      "subscribe",
    ]));

    expect(realtime.handles[0].setAuth).toHaveBeenCalledExactlyOnceWith("header.payload.signature");
    await provider.destroy();
  });

  it("opens a fresh session before refreshing private channel auth with its returned token", async () => {
    const events: string[] = [];
    const realtime = lifecycleRealtimeHarness(events);
    const api = apiHarness();
    api.openSession = vi.fn(async () => {
      events.push("open-session");
      return baseSession({
        realtimeToken: "platform.jwt.new",
        realtimeExpiresAt: "2099-01-01T00:01:00.000Z",
      });
    });
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      new Y.Doc(),
      {
        api,
        outbox: new CapabilityOutbox("snote-capability-provider-test"),
        realtimeFactory: realtime.factory,
      },
    );
    await provider.connect({ name: "Tester", color: "#123456" });
    await vi.waitFor(() => expect(events).toEqual([
      "set-auth:header.payload.signature",
      "subscribe",
    ]));
    events.length = 0;

    await provider.refreshNow();

    expect(events).toEqual(["open-session", "set-auth:platform.jwt.new"]);
    expect(realtime.handles).toHaveLength(1);
    expect(realtime.handles[0].setAuth).toHaveBeenLastCalledWith("platform.jwt.new");
    await provider.destroy();
  });

  it("disposes private realtime and never sends a null token when a refreshed session falls back to polling", async () => {
    const events: string[] = [];
    const realtime = lifecycleRealtimeHarness(events);
    const api = apiHarness();
    api.openSession = vi.fn(async () => pollingSession());
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      new Y.Doc(),
      {
        api,
        outbox: new CapabilityOutbox("snote-capability-provider-test"),
        realtimeFactory: realtime.factory,
      },
    );
    await provider.connect({ name: "Tester", color: "#123456" });

    await provider.refreshNow();

    expect(realtime.handles[0].dispose).toHaveBeenCalledOnce();
    expect(realtime.realtimeFactory).not.toHaveBeenCalledWith(
      expect.objectContaining({ syncTransport: "polling" }),
    );
    expect(realtime.handles[0].setAuth).not.toHaveBeenCalledWith(null);
    await provider.destroy();
    expect(realtime.handles[0].dispose).toHaveBeenCalledOnce();
  });

  it("creates a private channel only after a polling session refresh returns managed realtime auth", async () => {
    const events: string[] = [];
    const realtime = lifecycleRealtimeHarness(events);
    const api = apiHarness();
    api.openSession = vi.fn(async () => {
      events.push("open-session");
      return baseSession({
        realtimeToken: "platform.jwt.new",
        realtimeExpiresAt: "2099-01-01T00:01:00.000Z",
      });
    });
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      pollingSession(),
      new Y.Doc(),
      {
        api,
        outbox: new CapabilityOutbox("snote-capability-provider-test"),
        realtimeFactory: realtime.factory,
      },
    );
    await provider.connect({ name: "Tester", color: "#123456" });

    expect(realtime.realtimeFactory).not.toHaveBeenCalled();
    await provider.refreshNow();

    expect(events).toEqual([
      "open-session",
      "set-auth:platform.jwt.new",
      "subscribe",
    ]);
    expect(realtime.realtimeFactory).not.toHaveBeenCalledWith(
      expect.objectContaining({ syncTransport: "polling" }),
    );
    await provider.destroy();
  });

  it("polls a view capability without creating Realtime or a writable outbox", async () => {
    const polling = pollingEventHarness();
    const api = apiHarness();
    api.openSession = vi.fn(async () => pollingSession({ scope: "view" }));
    const realtimeFactory = vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory;
    const provider = new CapabilityYjsProvider(
      { slug: null, scope: "view", token: TOKEN },
      pollingSession({ scope: "view" }),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox("snote-capability-polling-view-test"),
        realtimeFactory,
        polling: {
          isHidden: polling.isHidden,
          random: () => 0.5,
          eventTarget: polling.eventTarget,
          documentTarget: polling.documentTarget,
        },
      },
    );

    await provider.connect({ name: "Viewer", color: "#123456" });
    polling.emitWindow("focus");
    await vi.waitFor(() => expect(api.openSession).toHaveBeenCalledOnce());
    polling.emitWindow("online");
    await vi.waitFor(() => expect(api.openSession).toHaveBeenCalledTimes(2));
    polling.setHidden(false);
    polling.emitDocument("visibilitychange");
    await vi.waitFor(() => expect(api.openSession).toHaveBeenCalledTimes(3));

    expect(api.openSession).toHaveBeenCalledTimes(3);
    expect(api.sync).not.toHaveBeenCalled();
    expect(realtimeFactory).not.toHaveBeenCalled();
    await provider.destroy();
    expect(polling.eventTarget.removeEventListener).toHaveBeenCalledTimes(2);
    expect(polling.documentTarget.removeEventListener).toHaveBeenCalledOnce();
  });

  it("upgrades polling to private Realtime when a durable poll returns managed auth", async () => {
    const polling = pollingEventHarness();
    const events: string[] = [];
    const realtime = lifecycleRealtimeHarness(events);
    const api = apiHarness();
    api.openSession = vi.fn(async () => baseSession({
      scope: "view",
      realtimeToken: "platform.jwt.from-poll",
      realtimeExpiresAt: "2099-01-01T00:01:00.000Z",
    }));
    const provider = new CapabilityYjsProvider(
      { slug: null, scope: "view", token: TOKEN },
      pollingSession({ scope: "view" }),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox("snote-capability-polling-upgrade-test"),
        realtimeFactory: realtime.factory,
        polling: {
          isHidden: polling.isHidden,
          random: () => 0.5,
          eventTarget: polling.eventTarget,
          documentTarget: polling.documentTarget,
        },
      },
    );

    await provider.connect({ name: "Viewer", color: "#123456" });
    polling.emitWindow("focus");
    await vi.waitFor(() => expect(realtime.handles).toHaveLength(1));

    expect(provider.getSession()).toMatchObject({
      syncTransport: "private-realtime",
      realtimeToken: "platform.jwt.from-poll",
    });
    expect(events).toEqual([
      "set-auth:platform.jwt.from-poll",
      "subscribe",
    ]);
    await provider.destroy();
  });

  it("keeps a polling-only provider on polling when a durable poll returns managed auth", async () => {
    const polling = pollingEventHarness();
    const realtime = lifecycleRealtimeHarness([]);
    const api = apiHarness();
    api.openSession = vi.fn(async () => baseSession({
      scope: "view",
      realtimeToken: "platform.jwt.from-poll",
      realtimeExpiresAt: "2099-01-01T00:01:00.000Z",
    }));
    const provider = new CapabilityYjsProvider(
      { slug: null, scope: "view", token: TOKEN },
      pollingSession({ scope: "view" }),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox("snote-capability-polling-only-view-test"),
        realtimeFactory: realtime.factory,
        pollingOnly: true,
        polling: {
          isHidden: polling.isHidden,
          random: () => 0.5,
          eventTarget: polling.eventTarget,
          documentTarget: polling.documentTarget,
        },
      },
    );
    try {
      await provider.connect({ name: "Viewer", color: "#123456" });
      polling.emitWindow("focus");
      await vi.waitFor(() => expect(api.openSession).toHaveBeenCalledOnce());

      expect(provider.getSession()).toMatchObject({
        syncTransport: "polling",
        realtimeToken: null,
        realtimeExpiresAt: null,
      });
      expect(realtime.realtimeFactory).not.toHaveBeenCalled();
    } finally {
      await provider.destroy();
    }
  });

  it("rejects locator drift from a refreshed polling-only session", async () => {
    const realtimeFactory = vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory;
    const api = apiHarness();
    api.openSession = vi.fn(async () => pollingSession({ slug: "renamed" }));
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      pollingSession(),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox("snote-capability-polling-only-locator-test"),
        realtimeFactory,
        pollingOnly: true,
      },
    );

    try {
      await expect(provider.refreshNow()).rejects.toThrow("capability locator mismatch");
      expect(provider.getSession().slug).toBe("daily");
      expect(realtimeFactory).not.toHaveBeenCalled();
    } finally {
      await provider.destroy();
    }
  });

  it("keeps durable polling alive when private Realtime startup fails", async () => {
    const polling = pollingEventHarness();
    const api = apiHarness();
    api.openSession = vi.fn(async () => baseSession({
      scope: "view",
      realtimeToken: "platform.jwt.blocked",
      realtimeExpiresAt: "2099-01-01T00:01:00.000Z",
    }));
    const realtimeFactory = vi.fn(async () => {
      throw new Error("websocket blocked");
    }) as CapabilityRealtimeFactory;
    const provider = new CapabilityYjsProvider(
      { slug: null, scope: "view", token: TOKEN },
      pollingSession({ scope: "view" }),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox("snote-capability-polling-private-fallback-test"),
        realtimeFactory,
        polling: {
          isHidden: polling.isHidden,
          random: () => 0.5,
          eventTarget: polling.eventTarget,
          documentTarget: polling.documentTarget,
        },
      },
    );

    try {
      await provider.connect({ name: "Viewer", color: "#123456" });
      polling.emitWindow("focus");
      await vi.waitFor(() => expect(realtimeFactory).toHaveBeenCalledOnce());

      // The provisional attempt keeps the original polling controller alive;
      // a failed factory must not tear down/re-register its wake listeners.
      expect(polling.eventTarget.addEventListener).toHaveBeenCalledTimes(2);
      expect(polling.documentTarget.addEventListener).toHaveBeenCalledTimes(1);
      polling.emitWindow("online");
      await vi.waitFor(() => expect(api.openSession).toHaveBeenCalledTimes(2));
    } finally {
      await provider.destroy();
    }
  });

  it("does not advance the durable session when a refreshed update fails validation", async () => {
    const api = apiHarness();
    api.openSession = vi.fn(async () => baseSession({
      currentSequence: 1,
      missingUpdates: [{
        updateId: "0".repeat(64),
        payload: "AQ",
        sequence: 1,
        encryptionVersion: 0,
      }],
    }));
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox("snote-capability-transactional-session-test"),
        realtimeFactory: vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory,
      },
    );

    try {
      await expect(provider.refreshNow()).rejects.toThrow("update hash mismatch");
      expect(provider.getSession().currentSequence).toBe(0);
    } finally {
      await provider.destroy();
    }
  });

  it("does not apply a deferred encrypted outbox update after teardown starts", async () => {
    const decryptResult = deferred<Uint8Array>();
    let decryptStarted!: () => void;
    const decrypting = new Promise<void>((resolve) => { decryptStarted = resolve; });
    const encryption = {
      encrypt: vi.fn(async (bytes: Uint8Array) => bytes),
      decrypt: vi.fn(async () => {
        decryptStarted();
        return decryptResult.promise;
      }),
    };
    const encryptedSession = baseSession({
      scope: "owner",
      encryption: {
        enabled: true,
        version: 1,
        salt: "salt",
        check: "check",
        iterations: 600_000,
      },
    });
    const outbox = testOutbox("snote-capability-outbox-teardown-decrypt-test");
    const ciphertext = new Uint8Array([1, 2, 3]);
    await outbox.enqueue({
      noteId: NOTE_ID,
      scope: "owner",
      generation: 1,
      updateId: await capabilityPayloadId(ciphertext),
      payload: encode(ciphertext),
      encryptionVersion: 1,
      createdAt: 0,
    });
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "owner", token: TOKEN },
      encryptedSession,
      doc,
      {
        api: apiHarness(async () => { throw new Error("offline"); }),
        outbox,
        realtimeFactory: vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory,
      },
      encryption,
    );

    const connecting = provider.connect({ name: "Owner", color: "#123456" });
    await decrypting;
    const closing = provider.destroy();
    const staleSource = new Y.Doc();
    staleSource.getText("content").insert(0, "stale decrypted update");
    decryptResult.resolve(Y.encodeStateAsUpdate(staleSource));
    await Promise.all([connecting, closing]);

    expect(doc.getText("content").toString()).toBe("");
  });

  it("keeps durable polling available until a private Realtime handshake is subscribed", async () => {
    const polling = pollingEventHarness();
    const factoryResult = deferred<CapabilityRealtimeHandle>();
    let statusHandler: ((status: string) => void | Promise<void>) | undefined;
    const channel = {
      on: vi.fn(() => channel),
      subscribe: vi.fn(async (handler: (status: string) => void | Promise<void>) => {
        statusHandler = handler;
        return channel;
      }),
      send: vi.fn(async () => "ok"),
      unsubscribe: vi.fn(async () => "ok"),
    };
    const handle: CapabilityRealtimeHandle = {
      channel,
      setAuth: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const api = apiHarness();
    api.openSession = vi.fn(async () => baseSession({ scope: "view" }));
    const provider = new CapabilityYjsProvider(
      { slug: null, scope: "view", token: TOKEN },
      baseSession({ scope: "view" }),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox("snote-capability-provisional-private-test"),
        realtimeFactory: vi.fn(() => factoryResult.promise) as CapabilityRealtimeFactory,
        polling: {
          isHidden: polling.isHidden,
          random: () => 0.5,
          eventTarget: polling.eventTarget,
          documentTarget: polling.documentTarget,
        },
      },
    );

    try {
      await provider.connect({ name: "Viewer", color: "#123456" });
      polling.emitWindow("online");
      await vi.waitFor(() => expect(api.openSession).toHaveBeenCalledOnce());

      factoryResult.resolve(handle);
      await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalledOnce());
      await statusHandler?.("SUBSCRIBED");

      expect(polling.eventTarget.removeEventListener).toHaveBeenCalledTimes(2);
      polling.emitWindow("online");
      expect(api.openSession).toHaveBeenCalledOnce();
    } finally {
      await provider.destroy();
    }
  });

  it("does not broadcast over a provisional private channel before SUBSCRIBED", async () => {
    const polling = pollingEventHarness();
    let statusHandler: ((status: string) => void | Promise<void>) | undefined;
    const channel = {
      on: vi.fn(() => channel),
      subscribe: vi.fn(async (handler: (status: string) => void | Promise<void>) => {
        statusHandler = handler;
        return channel;
      }),
      send: vi.fn(async () => "ok"),
      unsubscribe: vi.fn(async () => "ok"),
    };
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      new Y.Doc(),
      {
        api: apiHarness(),
        outbox: testOutbox("snote-capability-provisional-private-outbound-test"),
        realtimeFactory: vi.fn(async () => ({
          channel,
          setAuth: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
        })) as CapabilityRealtimeFactory,
        polling: {
          isHidden: polling.isHidden,
          random: () => 0.5,
          eventTarget: polling.eventTarget,
          documentTarget: polling.documentTarget,
        },
      },
    );

    try {
      await provider.connect({ name: "Editor", color: "#123456" });
      await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalledOnce());
      polling.emitWindow("online");
      await vi.waitFor(() => expect(provider.connected).toBe(true));

      provider.doc.getText("content").insert(0, "must remain durable only");
      provider.awareness.setLocalStateField("cursor", { anchor: 0, head: 0 });
      await provider.whenLocalUpdatesPersisted();
      expect(channel.send).not.toHaveBeenCalled();

      await statusHandler?.("SUBSCRIBED");
      channel.send.mockClear();
      provider.doc.getText("content").insert(0, " now broadcast");
      await provider.whenLocalUpdatesPersisted();
      await vi.waitFor(() => expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
        event: "y-update",
      })));

      channel.send.mockClear();
      provider.awareness.setLocalStateField("cursor", { anchor: 1, head: 1 });
      await vi.waitFor(() => expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
        event: "awareness",
      })));
    } finally {
      await provider.destroy();
    }
  });

  it("ignores a stale private factory rejection after a newer session starts", async () => {
    const polling = pollingEventHarness();
    const firstFactoryResult = deferred<CapabilityRealtimeHandle>();
    const secondFactoryResult = deferred<CapabilityRealtimeHandle>();
    let secondStatusHandler: ((status: string) => void | Promise<void>) | undefined;
    const secondChannel = {
      on: vi.fn(() => secondChannel),
      subscribe: vi.fn(async (handler: (status: string) => void | Promise<void>) => {
        secondStatusHandler = handler;
        return secondChannel;
      }),
      send: vi.fn(async () => "ok"),
      unsubscribe: vi.fn(async () => "ok"),
    };
    const secondHandle: CapabilityRealtimeHandle = {
      channel: secondChannel,
      setAuth: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const factory = vi.fn()
      .mockImplementationOnce(() => firstFactoryResult.promise)
      .mockImplementationOnce(() => secondFactoryResult.promise);
    const api = apiHarness();
    api.openSession = vi.fn(async () => baseSession({
      scope: "view",
      realtimeToken: "header.payload.newer",
    }));
    const provider = new CapabilityYjsProvider(
      { slug: null, scope: "view", token: TOKEN },
      baseSession({ scope: "view" }),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox("snote-capability-stale-private-factory-test"),
        realtimeFactory: factory as CapabilityRealtimeFactory,
        polling: {
          isHidden: polling.isHidden,
          random: () => 0.5,
          eventTarget: polling.eventTarget,
          documentTarget: polling.documentTarget,
        },
      },
    );
    const errors: string[] = [];
    provider.onSyncEvent((event) => {
      if (event.type === "error") errors.push(event.message ?? "");
    });

    try {
      await provider.connect({ name: "Viewer", color: "#123456" });
      await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
      await provider.refreshNow(true);
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));

      firstFactoryResult.reject(new Error("stale factory failed"));
      await Promise.resolve();
      await Promise.resolve();
      secondFactoryResult.resolve(secondHandle);
      await vi.waitFor(() => expect(secondChannel.subscribe).toHaveBeenCalledOnce());
      await secondStatusHandler?.("SUBSCRIBED");

      expect(errors).toEqual([]);
      expect(secondHandle.dispose).not.toHaveBeenCalled();
      expect(polling.eventTarget.removeEventListener).toHaveBeenCalledTimes(2);
    } finally {
      await provider.destroy();
    }
  });

  it("falls back to durable polling when an active private channel closes", async () => {
    const polling = pollingEventHarness();
    const realtime = controllableRealtimeHarness();
    const api = apiHarness();
    api.openSession = vi.fn(async () => pollingSession({ scope: "view" }));
    const provider = new CapabilityYjsProvider(
      { slug: null, scope: "view", token: TOKEN },
      baseSession({ scope: "view" }),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox("snote-capability-polling-channel-fallback-test"),
        realtimeFactory: realtime.factory,
        polling: {
          isHidden: polling.isHidden,
          random: () => 0.5,
          eventTarget: polling.eventTarget,
          documentTarget: polling.documentTarget,
        },
      },
    );

    try {
      await provider.connect({ name: "Viewer", color: "#123456" });
      await realtime.emitStatus("CHANNEL_ERROR");

      expect(polling.eventTarget.addEventListener).toHaveBeenCalledTimes(2);
      expect(polling.documentTarget.addEventListener).toHaveBeenCalledOnce();
      polling.emitWindow("online");
      await vi.waitFor(() => expect(api.openSession).toHaveBeenCalledOnce());
    } finally {
      await provider.destroy();
    }
  });

  it("keeps polling fallback after a late private Realtime auth refresh resolves", async () => {
    const polling = pollingEventHarness();
    const setAuthResult = deferred<void>();
    let statusHandler: ((status: string) => void | Promise<void>) | undefined;
    const channel = {
      on: vi.fn(() => channel),
      subscribe: vi.fn(async (handler: (status: string) => void | Promise<void>) => {
        statusHandler = handler;
        await handler("SUBSCRIBED");
        return channel;
      }),
      send: vi.fn(async () => "ok"),
      unsubscribe: vi.fn(async () => "ok"),
    };
    const setAuth = vi.fn(() => setAuthResult.promise);
    const api = apiHarness();
    api.openSession = vi.fn(async () => baseSession({
      scope: "view",
      realtimeToken: "header.payload.refreshed",
    }));
    const provider = new CapabilityYjsProvider(
      { slug: null, scope: "view", token: TOKEN },
      baseSession({ scope: "view" }),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox("snote-capability-private-set-auth-race-test"),
        realtimeFactory: vi.fn(async () => ({
          channel,
          setAuth,
          dispose: vi.fn(async () => {}),
        })) as CapabilityRealtimeFactory,
        polling: {
          isHidden: polling.isHidden,
          random: () => 0.5,
          eventTarget: polling.eventTarget,
          documentTarget: polling.documentTarget,
        },
      },
    );

    try {
      await provider.connect({ name: "Viewer", color: "#123456" });
      await vi.waitFor(() => expect(provider.connected).toBe(true));
      const refreshing = provider.refreshNow(true);
      await vi.waitFor(() => expect(setAuth).toHaveBeenCalledOnce());

      await statusHandler?.("CHANNEL_ERROR");
      setAuthResult.resolve();
      await refreshing;
      expect(polling.eventTarget.addEventListener).toHaveBeenCalledTimes(4);
      polling.emitWindow("online");
      await vi.waitFor(() => expect(api.openSession).toHaveBeenCalledTimes(2));
    } finally {
      await provider.destroy();
    }
  });

  it("starts durable polling before a stalled private channel dispose finishes", async () => {
    const polling = pollingEventHarness();
    const disposeDeferred = deferred<void>();
    let statusHandler: ((status: string) => void | Promise<void>) | undefined;
    const channel = {
      on: vi.fn(() => channel),
      subscribe: vi.fn(async (handler: (status: string) => void | Promise<void>) => {
        statusHandler = handler;
        return channel;
      }),
      send: vi.fn(async () => "ok"),
      unsubscribe: vi.fn(async () => "ok"),
    };
    const dispose = vi.fn(() => disposeDeferred.promise);
    const provider = new CapabilityYjsProvider(
      { slug: null, scope: "view", token: TOKEN },
      baseSession({ scope: "view" }),
      new Y.Doc(),
      {
        api: apiHarness(),
        outbox: testOutbox("snote-capability-private-dispose-fallback-test"),
        realtimeFactory: vi.fn(async () => ({
          channel,
          setAuth: vi.fn(async () => {}),
          dispose,
        })) as CapabilityRealtimeFactory,
        polling: {
          isHidden: polling.isHidden,
          random: () => 0.5,
          eventTarget: polling.eventTarget,
          documentTarget: polling.documentTarget,
        },
      },
    );

    try {
      await provider.connect({ name: "Viewer", color: "#123456" });
      if (!statusHandler) throw new Error("private channel did not subscribe");

      await statusHandler("CHANNEL_ERROR");

      expect(dispose).toHaveBeenCalledOnce();
      expect(polling.eventTarget.addEventListener).toHaveBeenCalledTimes(2);
      expect(polling.documentTarget.addEventListener).toHaveBeenCalledOnce();
    } finally {
      disposeDeferred.resolve();
      await provider.destroy();
    }
  });

  it("paces private-Realtime promotion attempts while durable polling remains available", async () => {
    const polling = pollingEventHarness();
    const timers = pollingTimerHarness();
    const api = apiHarness();
    api.openSession = vi.fn(async () => baseSession({ scope: "view" }));
    const realtimeFactory = vi.fn()
      .mockRejectedValueOnce(new Error("websocket blocked"))
      .mockResolvedValue(realtimeHandle()) as CapabilityRealtimeFactory;
    const provider = new CapabilityYjsProvider(
      { slug: null, scope: "view", token: TOKEN },
      baseSession({ scope: "view" }),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox("snote-capability-private-promotion-backoff-test"),
        realtimeFactory,
        now: timers.now,
        timers: { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
        polling: {
          isHidden: polling.isHidden,
          random: () => 0.5,
          now: timers.now,
          setTimer: timers.setTimer,
          clearTimer: timers.clearTimer,
          eventTarget: polling.eventTarget,
          documentTarget: polling.documentTarget,
        },
      },
    );

    try {
      await provider.connect({ name: "Viewer", color: "#123456" });
      expect(realtimeFactory).toHaveBeenCalledOnce();
      expect(timers.nextDelay()).toBe(2_000);

      await timers.advanceBy(2_000);
      await vi.waitFor(() => expect(api.openSession).toHaveBeenCalledOnce());
      expect(realtimeFactory).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(timers.nextDelay()).toBe(2_000));

      await timers.advanceBy(2_000);
      await vi.waitFor(() => expect(realtimeFactory).toHaveBeenCalledTimes(2));
    } finally {
      await provider.destroy();
    }
  });

  it.each([
    [401, "unauthorized"],
    [409, "read_only"],
    [409, "append_encryption_conflict"],
    [409, "quota_exceeded"],
  ])("fences a polling writer on terminal capability status %i/%s while retaining its outbox", async (status, code) => {
    const polling = pollingEventHarness();
    const api = apiHarness(async () => {
      throw new CapabilityApiError(
        "capability revoked",
        status,
        null,
        code,
      );
    });
    api.openSession = vi.fn(async () => pollingSession());
    const outbox = testOutbox(`snote-capability-polling-terminal-${status}-${code}-test`);
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      pollingSession(),
      new Y.Doc(),
      {
        api,
        outbox,
        realtimeFactory: vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory,
        polling: {
          isHidden: polling.isHidden,
          random: () => 0.5,
          eventTarget: polling.eventTarget,
          documentTarget: polling.documentTarget,
        },
      },
    );
    const fences: boolean[] = [];
    provider.onWriteFence((value) => fences.push(value));

    await provider.connect({ name: "Editor", color: "#123456" });
    provider.doc.getText("content").insert(0, "retain this edit");
    await provider.whenLocalUpdatesPersisted();
    await provider.flushNow();
    const callsBeforeWake = vi.mocked(api.sync).mock.calls.length
      + vi.mocked(api.openSession).mock.calls.length;
    polling.emitWindow("focus");
    polling.emitWindow("online");
    polling.emitDocument("visibilitychange");

    expect(fences.at(-1)).toBe(true);
    expect(await outbox.list(NOTE_ID, "edit", 1)).toHaveLength(1);
    expect(
      vi.mocked(api.sync).mock.calls.length + vi.mocked(api.openSession).mock.calls.length,
    ).toBe(callsBeforeWake);
    await provider.destroy();
  });

  it.each([401, 409])("stops polling after terminal open-session status %i", async (status) => {
    const polling = pollingEventHarness();
    const api = apiHarness();
    api.openSession = vi.fn(async () => {
      throw new CapabilityApiError(
        "capability revoked",
        status,
        null,
        status === 409 ? "read_only" : "unauthorized",
      );
    });
    const provider = new CapabilityYjsProvider(
      { slug: null, scope: "view", token: TOKEN },
      pollingSession({ scope: "view" }),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox(`snote-capability-polling-open-session-terminal-${status}-test`),
        realtimeFactory: vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory,
        polling: {
          isHidden: polling.isHidden,
          random: () => 0.5,
          eventTarget: polling.eventTarget,
          documentTarget: polling.documentTarget,
        },
      },
    );
    const fences: boolean[] = [];
    provider.onWriteFence((value) => fences.push(value));

    await provider.connect({ name: "Viewer", color: "#123456" });
    polling.emitWindow("focus");
    await vi.waitFor(() => expect(api.openSession).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(fences.at(-1)).toBe(true));

    polling.emitWindow("focus");
    polling.emitWindow("online");
    polling.emitDocument("visibilitychange");
    expect(api.openSession).toHaveBeenCalledOnce();
    expect(polling.eventTarget.removeEventListener).toHaveBeenCalledTimes(2);
    expect(polling.documentTarget.removeEventListener).toHaveBeenCalledOnce();
    await provider.destroy();
  });

  it("does not emit a stale polling failure after teardown has begun", async () => {
    const polling = pollingEventHarness();
    const opening = deferred<PollingNoteSession>();
    const api = apiHarness();
    api.openSession = vi.fn(() => opening.promise);
    const provider = new CapabilityYjsProvider(
      { slug: null, scope: "view", token: TOKEN },
      pollingSession({ scope: "view" }),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox("snote-capability-polling-destroy-inflight-test"),
        realtimeFactory: vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory,
        polling: {
          isHidden: polling.isHidden,
          random: () => 0.5,
          eventTarget: polling.eventTarget,
          documentTarget: polling.documentTarget,
        },
      },
    );
    const events: string[] = [];
    provider.onSyncEvent((event) => events.push(event.type));

    await provider.connect({ name: "Viewer", color: "#123456" });
    polling.emitWindow("online");
    await vi.waitFor(() => expect(api.openSession).toHaveBeenCalledOnce());

    await provider.destroy();
    opening.reject(new Error("offline after close"));
    await Promise.resolve();
    await Promise.resolve();

    expect(events).not.toContain("error");
    expect(events).not.toContain("offline");
  });

  it("stops after acknowledging the first quarantined batch instead of sending queued follow-up batches", async () => {
    const outbox = testOutbox("snote-capability-polling-quarantine-test");
    const source = new Y.Doc();
    const updates: Uint8Array[] = [];
    source.on("update", (update) => updates.push(update));
    for (let index = 0; index < 101; index += 1) {
      source.getText("content").insert(index, String.fromCharCode(65 + (index % 26)));
    }
    await Promise.all(updates.map(async (update, index) => outbox.enqueue({
      noteId: NOTE_ID,
      scope: "edit",
      generation: 1,
      updateId: await capabilityPayloadId(update),
      payload: encode(update),
      encryptionVersion: 0,
      createdAt: index,
    })));

    let calls = 0;
    const api = apiHarness(async (_token, body) => {
      calls += 1;
      return {
        acknowledgements: body.updates.map((update, index) => ({
          updateId: update.updateId,
          sequence: index + 1,
        })),
        session: pollingSession({
          syncStatus: "read_only_quarantine",
          currentSequence: calls === 1 ? 100 : 101,
        }),
      };
    });
    api.openSession = vi.fn(async () => pollingSession());
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      pollingSession(),
      new Y.Doc(),
      {
        api,
        outbox,
        realtimeFactory: vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory,
      },
    );
    const fences: boolean[] = [];
    provider.onWriteFence((value) => fences.push(value));

    try {
      await provider.connect({ name: "Editor", color: "#123456" });
      await provider.flushNow();

      expect(calls).toBe(1);
      expect(fences.at(-1)).toBe(true);
      expect(await outbox.list(NOTE_ID, "edit", 1)).toHaveLength(1);
    } finally {
      await provider.destroy();
    }
  });

  it("persists writable polling updates before sync and only removes acknowledged rows", async () => {
    const firstSync = deferred<Awaited<ReturnType<CapabilityApi["sync"]>>>();
    const secondSync = deferred<Awaited<ReturnType<CapabilityApi["sync"]>>>();
    let syncCalls = 0;
    const api = apiHarness(async () => {
      syncCalls += 1;
      return syncCalls === 1 ? firstSync.promise : secondSync.promise;
    });
    api.openSession = vi.fn(async () => pollingSession());
    const outbox = testOutbox("snote-capability-polling-writable-test");
    const realtimeFactory = vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory;
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      pollingSession(),
      new Y.Doc(),
      { api, outbox, realtimeFactory },
    );

    await provider.connect({ name: "Editor", color: "#123456" });
    provider.doc.getText("content").insert(0, "first ");
    provider.doc.getText("content").insert(6, "second");
    await provider.whenLocalUpdatesPersisted();
    await vi.waitFor(() => expect(api.sync).toHaveBeenCalledOnce());

    const firstBatch = vi.mocked(api.sync).mock.calls[0][1].updates;
    expect(firstBatch).toHaveLength(2);
    expect(await outbox.list(NOTE_ID, "edit", 1)).toHaveLength(2);

    firstSync.resolve({
      acknowledgements: [{ updateId: firstBatch[0].updateId, sequence: 1 }],
      session: pollingSession({ currentSequence: 1 }),
    });
    await vi.waitFor(() => expect(api.sync).toHaveBeenCalledTimes(2));

    const remaining = await outbox.list(NOTE_ID, "edit", 1);
    expect(remaining.map((row) => row.updateId)).toEqual([firstBatch[1].updateId]);
    expect(vi.mocked(api.sync).mock.calls[1][1].updates).toEqual([
      expect.objectContaining({ updateId: firstBatch[1].updateId }),
    ]);
    expect(realtimeFactory).not.toHaveBeenCalled();

    secondSync.resolve({
      acknowledgements: [{ updateId: firstBatch[1].updateId, sequence: 2 }],
      session: pollingSession({ currentSequence: 2 }),
    });
    await vi.waitFor(async () => expect(await outbox.list(NOTE_ID, "edit", 1)).toHaveLength(0));
    await provider.destroy();
  });

  it("keeps an unacknowledged polling edit through teardown and reopen", async () => {
    const api = apiHarness(async () => { throw new Error("offline"); });
    api.openSession = vi.fn(async () => pollingSession());
    const outboxName = "snote-capability-polling-reopen-test";
    const outbox = testOutbox(outboxName);
    const realtimeFactory = vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory;
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      pollingSession(),
      new Y.Doc(),
      { api, outbox, realtimeFactory },
    );

    await provider.connect({ name: "Editor", color: "#123456" });
    provider.doc.getText("content").insert(0, "offline polling edit");
    await provider.whenLocalUpdatesPersisted();
    await provider.flushNow();

    expect(await outbox.list(NOTE_ID, "edit", 1)).toHaveLength(1);
    expect(realtimeFactory).not.toHaveBeenCalled();
    await provider.destroy();

    const recoveryApi = apiHarness(async (_token, body) => ({
      acknowledgements: body.updates.map((update, index) => ({
        updateId: update.updateId,
        sequence: index + 1,
      })),
      session: pollingSession({ currentSequence: body.updates.length }),
    }));
    recoveryApi.openSession = vi.fn(async () => pollingSession());
    const recoveredOutbox = testOutbox(outboxName);
    const recoveredProvider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      pollingSession(),
      new Y.Doc(),
      {
        api: recoveryApi,
        outbox: recoveredOutbox,
        realtimeFactory,
      },
    );

    await recoveredProvider.connect({ name: "Editor", color: "#123456" });
    await vi.waitFor(() => expect(recoveryApi.sync).toHaveBeenCalledOnce());

    expect(await recoveredOutbox.list(NOTE_ID, "edit", 1)).toHaveLength(0);
    expect(realtimeFactory).not.toHaveBeenCalled();
    await recoveredProvider.destroy();
  });

  it.each([
    [429, 60_000],
    [503, 4_000],
  ])("backs off polling after status %i instead of retrying every wake", async (status, delay) => {
    vi.useFakeTimers();
    const polling = pollingEventHarness();
    const api = apiHarness();
    api.openSession = vi.fn()
      .mockRejectedValueOnce(new CapabilityApiError(
        "temporarily unavailable",
        status,
        status === 429 ? 60_000 : null,
        status === 429 ? "rate_limited" : null,
      ))
      .mockResolvedValue(pollingSession({ scope: "view" }));
    const provider = new CapabilityYjsProvider(
      { slug: null, scope: "view", token: TOKEN },
      pollingSession({ scope: "view" }),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox(`snote-capability-polling-backoff-${status}-test`),
        realtimeFactory: vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory,
        polling: {
          isHidden: polling.isHidden,
          random: () => 0.5,
          eventTarget: polling.eventTarget,
          documentTarget: polling.documentTarget,
        },
      },
    );

    await provider.connect({ name: "Viewer", color: "#123456" });
    await vi.advanceTimersByTimeAsync(2_000);
    polling.emitWindow("online");
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(api.openSession).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.openSession).toHaveBeenCalledTimes(2);
    await provider.destroy();
  });

  it.each([
    [429, 60_000],
    [503, 4_000],
  ])("backs off writable polling after sync status %i without dropping queued updates", async (status, delay) => {
    const polling = pollingEventHarness();
    const timers = pollingTimerHarness();
    const api = apiHarness();
    api.sync = vi.fn()
      .mockRejectedValueOnce(new CapabilityApiError(
        "temporarily unavailable",
        status,
        status === 429 ? 60_000 : null,
        status === 429 ? "rate_limited" : null,
      ))
      .mockImplementation(async (_token, body) => ({
        acknowledgements: body.updates.map((update, index) => ({
          updateId: update.updateId,
          sequence: index + 1,
        })),
        session: pollingSession({ currentSequence: body.updates.length }),
      }));
    api.openSession = vi.fn(async () => pollingSession());
    const outbox = testOutbox(`snote-capability-polling-writable-backoff-${status}-test`);
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      pollingSession(),
      new Y.Doc(),
      {
        api,
        outbox,
        realtimeFactory: vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory,
        polling: {
          isHidden: polling.isHidden,
          random: () => 0.5,
          now: timers.now,
          setTimer: timers.setTimer,
          clearTimer: timers.clearTimer,
          eventTarget: polling.eventTarget,
          documentTarget: polling.documentTarget,
        },
      },
    );
    try {
      let errors = 0;
      const fences: boolean[] = [];
      provider.onSyncEvent((event) => {
        if (event.type === "error") errors += 1;
      });
      provider.onWriteFence((value) => fences.push(value));

      await provider.connect({ name: "Editor", color: "#123456" });
      provider.doc.getText("content").insert(0, "retain first update");
      await provider.whenLocalUpdatesPersisted();
      await vi.waitFor(() => expect(api.sync).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(errors).toBe(1));
      expect(await outbox.list(NOTE_ID, "edit", 1)).toHaveLength(1);
      expect(fences).toEqual([false]);
      expect(timers.nextDelay()).toBe(delay);

      provider.doc.getText("content").insert(0, "retain second update ");
      await provider.whenLocalUpdatesPersisted();
      polling.emitWindow("focus");
      polling.emitWindow("online");
      expect(timers.nextDelay()).toBe(delay);
      await timers.advanceBy(delay - 1);

      expect(api.sync).toHaveBeenCalledOnce();
      expect(await outbox.list(NOTE_ID, "edit", 1)).toHaveLength(2);
      await timers.advanceBy(1);
      await vi.waitFor(async () => expect(await outbox.list(NOTE_ID, "edit", 1)).toHaveLength(0));
      expect(api.sync).toHaveBeenCalledTimes(2);
    } finally {
      await provider.destroy();
    }
  });

  it("honors Retry-After for private-Realtime writes without dropping the durable outbox", async () => {
    const timers = pollingTimerHarness();
    const api = apiHarness();
    api.sync = vi.fn()
      .mockRejectedValueOnce(new CapabilityApiError("rate limited", 429, 60_000, "rate_limited"))
      .mockImplementation(async (_token, body) => ({
        acknowledgements: body.updates.map((update, index) => ({
          updateId: update.updateId,
          sequence: index + 1,
        })),
        session: baseSession({ currentSequence: body.updates.length }),
      }));
    const outbox = testOutbox("snote-capability-private-retry-after-test");
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      new Y.Doc(),
      {
        api,
        outbox,
        realtimeFactory: vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory,
        now: timers.now,
        timers: {
          setTimer: timers.setTimer,
          clearTimer: timers.clearTimer,
        },
      },
    );

    try {
      const fences: boolean[] = [];
      provider.onWriteFence((value) => fences.push(value));
      await provider.connect({ name: "Editor", color: "#123456" });
      provider.doc.getText("content").insert(0, "first private update");
      await provider.whenLocalUpdatesPersisted();
      await vi.waitFor(() => expect(api.sync).toHaveBeenCalledOnce());
      expect(await outbox.list(NOTE_ID, "edit", 1)).toHaveLength(1);
      expect(fences).toEqual([false]);
      expect(timers.nextDelay()).toBe(60_000);

      provider.doc.getText("content").insert(0, "second private update ");
      await provider.whenLocalUpdatesPersisted();
      await timers.advanceBy(59_999);
      expect(api.sync).toHaveBeenCalledOnce();
      expect(await outbox.list(NOTE_ID, "edit", 1)).toHaveLength(2);

      await timers.advanceBy(1);
      await vi.waitFor(async () => expect(await outbox.list(NOTE_ID, "edit", 1)).toHaveLength(0));
      expect(api.sync).toHaveBeenCalledTimes(2);
    } finally {
      await provider.destroy();
    }
  });

  it("honors Retry-After when refreshing a private Realtime session", async () => {
    const timers = pollingTimerHarness();
    const api = apiHarness();
    api.openSession = vi.fn()
      .mockRejectedValueOnce(new CapabilityApiError("rate limited", 429, 60_000, "rate_limited"))
      .mockResolvedValue(baseSession());
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox("snote-capability-private-refresh-retry-after-test"),
        realtimeFactory: vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory,
        now: timers.now,
        timers: { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
      },
    );

    try {
      await expect(provider.refreshNow(true)).rejects.toMatchObject({ status: 429 });
      expect(timers.nextDelay()).toBe(60_000);

      await timers.advanceBy(59_999);
      expect(api.openSession).toHaveBeenCalledOnce();
      await timers.advanceBy(1);
      await vi.waitFor(() => expect(api.openSession).toHaveBeenCalledTimes(2));
    } finally {
      await provider.destroy();
    }
  });

  it("does not bypass a private Retry-After during teardown", async () => {
    const timers = pollingTimerHarness();
    const api = apiHarness();
    api.sync = vi.fn().mockRejectedValueOnce(
      new CapabilityApiError("rate limited", 429, 60_000, "rate_limited"),
    );
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox("snote-capability-private-destroy-retry-after-test"),
        realtimeFactory: vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory,
        now: timers.now,
        timers: { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
      },
    );

    await provider.connect({ name: "Editor", color: "#123456" });
    provider.doc.getText("content").insert(0, "retain during close");
    await provider.whenLocalUpdatesPersisted();
    await vi.waitFor(() => expect(api.sync).toHaveBeenCalledOnce());
    expect(timers.nextDelay()).toBe(60_000);

    await provider.destroy();

    expect(api.sync).toHaveBeenCalledOnce();
    expect(timers.nextDelay()).toBeNull();
  });

  it("fences a private quota quarantine without retrying its durable outbox", async () => {
    const timers = pollingTimerHarness();
    const api = apiHarness();
    api.sync = vi.fn().mockRejectedValueOnce(
      new CapabilityApiError("note is read only", 409, null, "quota_exceeded"),
    );
    const outbox = testOutbox("snote-capability-private-quota-fence-test");
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      new Y.Doc(),
      {
        api,
        outbox,
        realtimeFactory: vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory,
        now: timers.now,
        timers: { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
      },
    );
    const fences: boolean[] = [];
    provider.onWriteFence((value) => fences.push(value));

    try {
      await provider.connect({ name: "Editor", color: "#123456" });
      provider.doc.getText("content").insert(0, "retain quarantined update");
      await provider.whenLocalUpdatesPersisted();
      await vi.waitFor(() => expect(api.sync).toHaveBeenCalledOnce());

      expect(fences).toEqual([false, true]);
      expect(await outbox.list(NOTE_ID, "edit", 1)).toHaveLength(1);
      expect(timers.nextDelay()).toBeNull();
      await timers.advanceBy(60_000);
      expect(api.sync).toHaveBeenCalledOnce();
    } finally {
      await provider.destroy();
    }
  });

  it("backs off checkpoint compaction on Retry-After without treating it as a CAS conflict", async () => {
    const timers = pollingTimerHarness();
    let checkpointAttempts = 0;
    const api = apiHarness(async (_token, body) => {
      if (!body.checkpoint) {
        return {
          acknowledgements: body.updates.map((update) => ({ updateId: update.updateId, sequence: 1 })),
          session: baseSession({ currentSequence: 1 }),
        };
      }
      checkpointAttempts += 1;
      if (checkpointAttempts === 1) {
        throw new CapabilityApiError("rate limited", 429, 60_000, "rate_limited");
      }
      return {
        acknowledgements: [],
        session: baseSession({
          currentSequence: 1,
          checkpointSequence: 1,
          checkpointVersion: 1,
          checkpointPayload: body.checkpoint.payload,
          checkpointEncryptionVersion: 0,
        }),
      };
    });
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      new Y.Doc(),
      {
        api,
        outbox: testOutbox("snote-capability-compaction-retry-after-test"),
        realtimeFactory: vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory,
        now: timers.now,
        timers: { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
        compactionThresholdUpdates: 1,
      },
    );

    try {
      await provider.connect({ name: "Editor", color: "#123456" });
      provider.doc.getText("content").insert(0, "checkpoint retry");
      await provider.whenLocalUpdatesPersisted();
      await vi.waitFor(() => expect(api.sync).toHaveBeenCalledTimes(2));

      expect(api.openSession).not.toHaveBeenCalled();
      expect(timers.nextDelay()).toBe(60_000);
      await timers.advanceBy(60_000);
      await vi.waitFor(() => expect(api.sync).toHaveBeenCalledTimes(3));
      expect(provider.getSession().checkpointSequence).toBe(1);
    } finally {
      await provider.destroy();
    }
  });

  it("fences encryption while stopping the old transport and restarts only the final selected private transport", async () => {
    const events: string[] = [];
    const realtime = lifecycleRealtimeHarness(events);
    const api = apiHarness();
    api.openSession = vi.fn()
      .mockResolvedValueOnce(pollingSession({ scope: "owner" }))
      .mockResolvedValueOnce(baseSession({
        scope: "owner",
        realtimeToken: "platform.jwt.after-transition",
        realtimeExpiresAt: "2099-01-01T00:01:00.000Z",
      }));
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "owner", token: TOKEN },
      baseSession({ scope: "owner" }),
      new Y.Doc(),
      {
        api,
        outbox: new CapabilityOutbox("snote-capability-provider-test"),
        realtimeFactory: realtime.factory,
      },
    );
    await provider.connect({ name: "Owner", color: "#123456" });
    await vi.waitFor(() => expect(events).toEqual([
      "set-auth:header.payload.signature",
      "subscribe",
    ]));
    events.length = 0;

    const session = await provider.prepareEncryptionTransition();

    expect(session).toMatchObject({ syncTransport: "private-realtime", realtimeToken: "platform.jwt.after-transition" });
    expect(realtime.handles[0].dispose).toHaveBeenCalledOnce();
    expect(realtime.realtimeFactory).toHaveBeenCalledTimes(2);
    expect(realtime.realtimeFactory).not.toHaveBeenCalledWith(
      expect.objectContaining({ syncTransport: "polling" }),
    );
    expect(events).toEqual([
      "dispose:header.payload.signature",
      "set-auth:platform.jwt.after-transition",
      "subscribe",
    ]);
    await provider.destroy();
    expect(realtime.handles[1].dispose).toHaveBeenCalledOnce();
  });

  it("disposes an active private transport exactly once when destroyed repeatedly", async () => {
    const events: string[] = [];
    const realtime = lifecycleRealtimeHarness(events);
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      new Y.Doc(),
      {
        api: apiHarness(),
        outbox: new CapabilityOutbox("snote-capability-provider-test"),
        realtimeFactory: realtime.factory,
      },
    );
    await provider.connect({ name: "Tester", color: "#123456" });

    await provider.destroy();
    await provider.destroy();

    expect(realtime.handles[0].dispose).toHaveBeenCalledOnce();
  });

  it("sets managed Auth before the default factory creates its private channel", () => {
    const implementation = providerSource();
    const auth = implementation.indexOf("await client.realtime.setAuth(session.realtimeToken)");
    const channel = implementation.indexOf("const channel = client.channel(session.realtimeTopic");

    expect(auth).toBeGreaterThan(-1);
    expect(channel).toBeGreaterThan(auth);
    expect(implementation).not.toContain("accessToken: async");
  });

  it("disposes private Realtime when a sync response falls back to polling", async () => {
    const events: string[] = [];
    const realtime = lifecycleRealtimeHarness(events);
    const pendingSync = deferred<Awaited<ReturnType<CapabilityApi["sync"]>>>();
    const api = apiHarness(async () => pendingSync.promise);
    const outbox = new CapabilityOutbox("snote-capability-provider-test");
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      doc,
      { api, outbox, realtimeFactory: realtime.factory },
    );
    await provider.connect({ name: "Tester", color: "#123456" });
    await vi.waitFor(() => expect(events).toEqual([
      "set-auth:header.payload.signature",
      "subscribe",
    ]));
    events.length = 0;

    doc.getText("content").insert(0, "sync fallback");
    await provider.whenLocalUpdatesPersisted();
    const [pending] = await outbox.list(NOTE_ID, "edit", 1);
    pendingSync.resolve({
      acknowledgements: [{ updateId: pending.updateId, sequence: 1 }],
      session: pollingSession({ currentSequence: 1 }),
    });
    await provider.flushNow();
    const disposeCallsBeforeDestroy = realtime.handles[0].dispose.mock.calls.length;
    await provider.destroy();

    expect(disposeCallsBeforeDestroy).toBe(1);
    expect(realtime.realtimeFactory).not.toHaveBeenCalledWith(
      expect.objectContaining({ syncTransport: "polling" }),
    );
  });

  it("creates private Realtime when a polling sync response receives managed Auth", async () => {
    const events: string[] = [];
    const realtime = lifecycleRealtimeHarness(events);
    const pendingSync = deferred<Awaited<ReturnType<CapabilityApi["sync"]>>>();
    const api = apiHarness(async () => pendingSync.promise);
    const outbox = new CapabilityOutbox("snote-capability-provider-test");
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      pollingSession(),
      doc,
      { api, outbox, realtimeFactory: realtime.factory },
    );
    await provider.connect({ name: "Tester", color: "#123456" });

    doc.getText("content").insert(0, "sync upgrade");
    await provider.whenLocalUpdatesPersisted();
    const [pending] = await outbox.list(NOTE_ID, "edit", 1);
    pendingSync.resolve({
      acknowledgements: [{ updateId: pending.updateId, sequence: 1 }],
      session: baseSession({
        currentSequence: 1,
        realtimeToken: "platform.jwt.from-sync",
        realtimeExpiresAt: "2099-01-01T00:01:00.000Z",
      }),
    });
    await provider.flushNow();
    const eventsBeforeDestroy = [...events];
    const factoryCallsBeforeDestroy = realtime.realtimeFactory.mock.calls.length;
    await provider.destroy();

    expect(eventsBeforeDestroy).toEqual([
      "set-auth:platform.jwt.from-sync",
      "subscribe",
    ]);
    expect(factoryCallsBeforeDestroy).toBe(1);
  });

  it("keeps a polling-only provider on polling when sync returns managed Auth", async () => {
    const realtime = lifecycleRealtimeHarness([]);
    const pendingSync = deferred<Awaited<ReturnType<CapabilityApi["sync"]>>>();
    const api = apiHarness(async () => pendingSync.promise);
    const outbox = new CapabilityOutbox("snote-capability-polling-only-sync-test");
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      pollingSession(),
      doc,
      { api, outbox, realtimeFactory: realtime.factory, pollingOnly: true },
    );
    try {
      await provider.connect({ name: "Tester", color: "#123456" });

      doc.getText("content").insert(0, "sync stays polling");
      await provider.whenLocalUpdatesPersisted();
      const [pending] = await outbox.list(NOTE_ID, "edit", 1);
      pendingSync.resolve({
        acknowledgements: [{ updateId: pending.updateId, sequence: 1 }],
        session: baseSession({
          currentSequence: 1,
          realtimeToken: "platform.jwt.from-sync",
          realtimeExpiresAt: "2099-01-01T00:01:00.000Z",
        }),
      });
      await provider.flushNow();

      expect(provider.getSession()).toMatchObject({
        syncTransport: "polling",
        realtimeToken: null,
        realtimeExpiresAt: null,
      });
      expect(realtime.realtimeFactory).not.toHaveBeenCalled();
    } finally {
      await provider.destroy();
    }
  });

  it("refreshes active private Realtime with the token returned by sync", async () => {
    const events: string[] = [];
    const realtime = lifecycleRealtimeHarness(events);
    const pendingSync = deferred<Awaited<ReturnType<CapabilityApi["sync"]>>>();
    const api = apiHarness(async () => pendingSync.promise);
    const outbox = new CapabilityOutbox("snote-capability-provider-test");
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      doc,
      { api, outbox, realtimeFactory: realtime.factory },
    );
    await provider.connect({ name: "Tester", color: "#123456" });
    await vi.waitFor(() => expect(events).toEqual([
      "set-auth:header.payload.signature",
      "subscribe",
    ]));
    events.length = 0;

    doc.getText("content").insert(0, "sync token refresh");
    await provider.whenLocalUpdatesPersisted();
    const [pending] = await outbox.list(NOTE_ID, "edit", 1);
    pendingSync.resolve({
      acknowledgements: [{ updateId: pending.updateId, sequence: 1 }],
      session: baseSession({
        currentSequence: 1,
        realtimeToken: "platform.jwt.from-sync",
        realtimeExpiresAt: "2099-01-01T00:01:00.000Z",
      }),
    });
    await provider.flushNow();
    const eventsBeforeDestroy = [...events];
    const handlesBeforeDestroy = realtime.handles.length;
    await provider.destroy();

    expect(eventsBeforeDestroy).toEqual(["set-auth:platform.jwt.from-sync"]);
    expect(handlesBeforeDestroy).toBe(1);
  });

  it("does not restart Realtime from an in-flight refresh during an encryption fence", async () => {
    const events: string[] = [];
    const realtime = lifecycleRealtimeHarness(events);
    const refreshSession = deferred<PrivateRealtimeNoteSession>();
    const firstTransitionSession = deferred<PollingNoteSession>();
    let enteredFirstTransition!: () => void;
    const firstTransitionEntered = new Promise<void>((resolve) => {
      enteredFirstTransition = resolve;
    });
    const api = apiHarness();
    api.openSession = vi.fn()
      .mockImplementationOnce(() => refreshSession.promise)
      .mockImplementationOnce(() => {
        enteredFirstTransition();
        return firstTransitionSession.promise;
      })
      .mockResolvedValueOnce(baseSession({
        scope: "owner",
        realtimeToken: "platform.jwt.after-fence",
        realtimeExpiresAt: "2099-01-01T00:01:00.000Z",
      }));
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "owner", token: TOKEN },
      baseSession({ scope: "owner" }),
      new Y.Doc(),
      {
        api,
        outbox: new CapabilityOutbox("snote-capability-provider-test"),
        realtimeFactory: realtime.factory,
      },
    );
    await provider.connect({ name: "Owner", color: "#123456" });
    await vi.waitFor(() => expect(events).toEqual([
      "set-auth:header.payload.signature",
      "subscribe",
    ]));
    events.length = 0;

    const refresh = provider.refreshNow();
    expect(api.openSession).toHaveBeenCalledOnce();
    const transition = provider.prepareEncryptionTransition();
    await vi.waitFor(() => expect(realtime.handles[0].dispose).toHaveBeenCalledOnce());
    // The transition waits behind an in-flight refresh rather than issuing an
    // out-of-order durable read. Its write fence still detaches the channel
    // before that refresh is allowed to finish.
    expect(api.openSession).toHaveBeenCalledOnce();

    refreshSession.resolve(baseSession({
      scope: "owner",
      realtimeToken: "platform.jwt.racing-refresh",
      realtimeExpiresAt: "2099-01-01T00:01:00.000Z",
    }));
    await refresh;
    await firstTransitionEntered;
    const handlesDuringFence = realtime.handles.length;
    const eventsDuringFence = [...events];

    firstTransitionSession.resolve(pollingSession({ scope: "owner" }));
    const session = await transition;
    const handlesAfterTransition = realtime.handles.length;
    const eventsAfterTransition = [...events];
    await provider.destroy();

    expect(handlesDuringFence).toBe(1);
    expect(eventsDuringFence).toEqual(["dispose:header.payload.signature"]);
    expect(session).toMatchObject({
      syncTransport: "private-realtime",
      realtimeToken: "platform.jwt.after-fence",
    });
    expect(handlesAfterTransition).toBe(2);
    expect(eventsAfterTransition).toEqual([
      "dispose:header.payload.signature",
      "set-auth:platform.jwt.after-fence",
      "subscribe",
    ]);
  });

  it("serializes a refresh behind an in-flight sync session reconciliation", async () => {
    const syncResponse = deferred<Awaited<ReturnType<CapabilityApi["sync"]>>>();
    const firstRealtime = deferred<CapabilityRealtimeHandle>();
    let enteredSync!: () => void;
    let startedRealtime!: () => void;
    const syncEntered = new Promise<void>((resolve) => { enteredSync = resolve; });
    const realtimeStarted = new Promise<void>((resolve) => { startedRealtime = resolve; });
    const api = apiHarness();
    api.sync = vi.fn(async () => {
      enteredSync();
      return syncResponse.promise;
    });
    const openSession = vi.fn(async () => baseSession({
      currentSequence: 1,
      realtimeToken: "platform.jwt.concurrent",
      realtimeExpiresAt: "2099-01-01T00:01:00.000Z",
    }));
    api.openSession = openSession;
    const factory = vi.fn(async () => {
      startedRealtime();
      return firstRealtime.promise;
    });
    const outbox = new CapabilityOutbox("snote-capability-provider-test");
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      pollingSession(),
      doc,
      { api, outbox, realtimeFactory: factory as CapabilityRealtimeFactory },
    );
    await provider.connect({ name: "Tester", color: "#123456" });

    doc.getText("content").insert(0, "sync and refresh race");
    await provider.whenLocalUpdatesPersisted();
    const [pending] = await outbox.list(NOTE_ID, "edit", 1);
    const syncing = provider.flushNow();
    await syncEntered;
    syncResponse.resolve({
      acknowledgements: [{ updateId: pending.updateId, sequence: 1 }],
      session: baseSession({
        currentSequence: 1,
        realtimeToken: "platform.jwt.concurrent",
        realtimeExpiresAt: "2099-01-01T00:01:00.000Z",
      }),
    });
    await realtimeStarted;

    const refreshing = provider.refreshNow();
    const openCallsWhileSyncReconciles = openSession.mock.calls.length;
    firstRealtime.resolve(realtimeHandle());
    await Promise.all([syncing, refreshing]);
    const factoryCalls = factory.mock.calls.length;
    await provider.destroy();

    expect(openCallsWhileSyncReconciles).toBe(0);
    expect(factoryCalls).toBe(1);
  });

  it("treats a second connect on a live provider as a no-op", async () => {
    const handle = realtimeHandle();
    const factory = vi.fn(async () => handle);
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      new Y.Doc(),
      {
        api: apiHarness(),
        outbox: new CapabilityOutbox("snote-capability-provider-test"),
        realtimeFactory: factory as CapabilityRealtimeFactory,
      },
    );

    await provider.connect({ name: "Tester", color: "#123456" });
    await provider.connect({ name: "Ghost", color: "#000000" });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(handle.dispose).not.toHaveBeenCalled();
    expect(provider.awareness.getLocalState()?.user).toEqual({
      name: "Tester",
      color: "#123456",
    });
    await provider.destroy();
  });

  it("joins an in-flight connect instead of starting a second Realtime", async () => {
    const factoryResult = deferred<CapabilityRealtimeHandle>();
    const handle = realtimeHandle();
    const factory = vi.fn().mockImplementation(() => factoryResult.promise);
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      new Y.Doc(),
      {
        api: apiHarness(),
        outbox: new CapabilityOutbox("snote-capability-provider-test"),
        realtimeFactory: factory as CapabilityRealtimeFactory,
      },
    );

    const firstConnect = provider.connect({ name: "Tester", color: "#123456" });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    const secondConnect = provider.connect({ name: "Ghost", color: "#000000" });
    expect(factory).toHaveBeenCalledTimes(1);
    factoryResult.resolve(handle);
    await Promise.all([firstConnect, secondConnect]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(handle.dispose).not.toHaveBeenCalled();
    expect(provider.awareness.getLocalState()?.user).toEqual({
      name: "Tester",
      color: "#123456",
    });
    await provider.destroy();
  });

  it("ignores callbacks emitted by a disposed private channel", async () => {
    const realtime = controllableRealtimeHarness();
    const api = apiHarness(async () => { throw new Error("offline"); });
    api.openSession = vi.fn(async () => pollingSession());
    const outbox = new CapabilityOutbox("snote-capability-provider-test");
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      doc,
      { api, outbox, realtimeFactory: realtime.factory },
    );
    await provider.connect({ name: "Tester", color: "#123456" });
    await realtime.emitStatus("SUBSCRIBED");
    await provider.refreshNow();
    expect(api.openSession).toHaveBeenCalledOnce();
    expect(provider.getSession().syncTransport).toBe("polling");
    expect(realtime.dispose).toHaveBeenCalledOnce();

    const remote = new Y.Doc();
    remote.getText("content").insert(0, "late update");
    const bytes = Y.encodeStateAsUpdate(remote);
    const updateId = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await realtime.emitStatus("SUBSCRIBED");
    await realtime.emitBroadcast("y-update", {
      updateId,
      payload: encode(bytes),
      encryptionVersion: 0,
    });
    await provider.whenLocalUpdatesPersisted();
    const connectedAfterLateCallback = provider.connected;
    const contentAfterLateCallback = doc.getText("content").toString();
    await provider.destroy();

    expect(realtime.dispose).toHaveBeenCalledOnce();
    expect(connectedAfterLateCallback).toBe(false);
    expect(contentAfterLateCallback).toBe("");
  });

  it("does not apply a peer update that was suspended when encryption fenced the transport", async () => {
    const realtime = controllableRealtimeHarness();
    const decryptGate = deferred<Uint8Array>();
    let decryptStarted!: () => void;
    const decrypting = new Promise<void>((resolve) => { decryptStarted = resolve; });
    const encryptionMetadata = {
      enabled: true,
      version: 1,
      salt: "salt",
      check: "check",
      iterations: 600_000,
    } as const;
    const encryptedOwnerSession = (overrides: Partial<PrivateRealtimeNoteSession> = {}) => baseSession({
      scope: "owner",
      encryption: encryptionMetadata,
      ...overrides,
    });
    const encryption = {
      encrypt: vi.fn(async (bytes: Uint8Array) => bytes),
      decrypt: vi.fn(async () => {
        decryptStarted();
        return decryptGate.promise;
      }),
    };
    const api = apiHarness(async (_token, body) => ({
      acknowledgements: body.updates.map((update, index) => ({
        updateId: update.updateId,
        sequence: index + 1,
      })),
      session: encryptedOwnerSession({ currentSequence: body.updates.length }),
    }));
    api.openSession = vi.fn(async () => encryptedOwnerSession({ currentSequence: 1 }));
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "owner", token: TOKEN },
      encryptedOwnerSession(),
      new Y.Doc(),
      {
        api,
        outbox: new CapabilityOutbox("snote-capability-provider-test"),
        realtimeFactory: realtime.factory,
      },
      encryption,
    );
    await provider.connect({ name: "Owner", color: "#123456" });
    await realtime.emitStatus("SUBSCRIBED");

    const peer = new Y.Doc();
    peer.getText("content").insert(0, "late encrypted peer update");
    const plaintext = Y.encodeStateAsUpdate(peer);
    const ciphertext = new Uint8Array([1, 2, 3]);
    const updateId = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const inbound = realtime.emitBroadcast("y-update", {
      updateId,
      payload: encode(ciphertext),
      encryptionVersion: 1,
    });
    await decrypting;

    await provider.prepareEncryptionTransition();
    decryptGate.resolve(plaintext);
    await inbound;
    const contentAfterFence = provider.doc.getText("content").toString();
    await provider.destroy();

    expect(contentAfterFence).toBe("");
  });

  it("persists an edit before acknowledgement and deletes it only after ack", async () => {
    let resolveSync!: (value: Awaited<ReturnType<CapabilityApi["sync"]>>) => void;
    const syncPending = new Promise<Awaited<ReturnType<CapabilityApi["sync"]>>>((resolve) => {
      resolveSync = resolve;
    });
    const api = apiHarness(async () => syncPending);
    const outbox = new CapabilityOutbox("snote-capability-provider-test");
    const realtime = realtimeHarness();
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      doc,
      { api, outbox, realtimeFactory: realtime.factory },
    );
    await provider.connect({ name: "Tester", color: "#123456" });

    doc.getText("content").insert(0, "typed before navigation");
    await provider.whenLocalUpdatesPersisted();

    expect(await outbox.list(NOTE_ID, "edit", 1)).toHaveLength(1);
    resolveSync({
      acknowledgements: [{
        updateId: (await outbox.list(NOTE_ID, "edit", 1))[0].updateId,
        sequence: 1,
      }],
      session: baseSession({ currentSequence: 1 }),
    });
    await provider.flushNow();
    expect(await outbox.list(NOTE_ID, "edit", 1)).toEqual([]);
    await provider.destroy();
  });

  it("keeps an unacknowledged edit across provider teardown and reopen", async () => {
    const api = apiHarness(async () => { throw new Error("offline"); });
    const outbox = new CapabilityOutbox("snote-capability-provider-test");
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      doc,
      { api, outbox, realtimeFactory: realtimeHarness().factory },
    );
    await provider.connect({ name: "Tester", color: "#123456" });
    doc.getText("content").insert(0, "offline edit");
    await provider.destroy();

    const reopened = new CapabilityOutbox("snote-capability-provider-test");
    expect(await reopened.list(NOTE_ID, "edit", 1)).toHaveLength(1);
    reopened.close();
  });

  it("persists a peer update by hash before a failed origin-independent flush", async () => {
    const api = apiHarness(async () => { throw new Error("origin closed"); });
    const outbox = new CapabilityOutbox("snote-capability-provider-test");
    const realtime = realtimeHarness();
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      doc,
      { api, outbox, realtimeFactory: realtime.factory },
    );
    await provider.connect({ name: "Tester", color: "#123456" });
    const remote = new Y.Doc();
    remote.getText("content").insert(0, "peer edit");
    const bytes = Y.encodeStateAsUpdate(remote);
    const payload = encode(bytes);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
    const updateId = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");

    await realtime.handlers.get("y-update")?.({
      payload: { updateId, payload, encryptionVersion: 0 },
    });
    await provider.whenLocalUpdatesPersisted();

    expect(doc.getText("content").toString()).toBe("peer edit");
    expect((await outbox.list(NOTE_ID, "edit", 1))[0].updateId).toBe(updateId);
    await provider.destroy();
  });

  it("applies view broadcasts without accumulating an outbox it cannot acknowledge", async () => {
    const api = apiHarness();
    const outbox = new CapabilityOutbox("snote-capability-provider-test");
    const realtime = realtimeHarness();
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: null, scope: "view", token: TOKEN },
      baseSession({ scope: "view" }),
      doc,
      { api, outbox, realtimeFactory: realtime.factory },
    );
    await provider.connect({ name: "Viewer", color: "#123456" });
    const remote = new Y.Doc();
    remote.getText("content").insert(0, "visible update");
    const bytes = Y.encodeStateAsUpdate(remote);
    const digestInput = new Uint8Array(bytes.byteLength);
    digestInput.set(bytes);
    const updateId = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");

    await realtime.handlers.get("y-update")?.({
      payload: { updateId, payload: encode(bytes), encryptionVersion: 0 },
    });

    expect(doc.getText("content").toString()).toBe("visible update");
    expect(await outbox.list(NOTE_ID, "edit", 1)).toEqual([]);
    expect(api.sync).not.toHaveBeenCalled();
    await provider.destroy();
  });

  it("never exposes a prior editor outbox to a view capability", async () => {
    const outbox = new CapabilityOutbox("snote-capability-provider-test");
    const source = new Y.Doc();
    source.getText("content").insert(0, "unpublished private edit");
    const bytes = Y.encodeStateAsUpdate(source);
    const updateId = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await outbox.enqueue({
      noteId: NOTE_ID,
      scope: "edit",
      generation: 1,
      updateId,
      payload: encode(bytes),
      encryptionVersion: 0,
      createdAt: Date.now(),
    });
    const api = apiHarness();
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: null, scope: "view", token: TOKEN },
      baseSession({ scope: "view" }),
      doc,
      { api, outbox, realtimeFactory: realtimeHarness().factory },
    );

    await provider.connect({ name: "Viewer", color: "#123456" });

    expect(doc.getText("content").toString()).toBe("");
    expect(provider.getPendingBytes()).toBe(0);
    expect(api.sync).not.toHaveBeenCalled();
    await provider.destroy();
  });

  it("does not replay an outbox created by a revoked capability generation", async () => {
    const outbox = new CapabilityOutbox("snote-capability-provider-test");
    const source = new Y.Doc();
    source.getText("content").insert(0, "revoked edit");
    const bytes = Y.encodeStateAsUpdate(source);
    const updateId = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await outbox.enqueue({
      noteId: NOTE_ID,
      scope: "edit",
      generation: 1,
      updateId,
      payload: encode(bytes),
      encryptionVersion: 0,
      createdAt: Date.now(),
    });
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession({ generation: 2 }),
      doc,
      {
        api: apiHarness(),
        outbox,
        realtimeFactory: realtimeHarness().factory,
      },
    );

    await provider.connect({ name: "Editor", color: "#123456" });

    expect(doc.getText("content").toString()).toBe("");
    expect(provider.getPendingBytes()).toBe(0);
    await provider.destroy();
  });

  it("durably saves a racing edit, then aborts the fenced encryption transition", async () => {
    const outbox = new CapabilityOutbox("snote-capability-provider-test");
    const realtime = realtimeHarness();
    const api = apiHarness();
    api.sync = vi.fn(async (_token, body) => ({
      acknowledgements: body.updates.map((update, index) => ({
        updateId: update.updateId,
        sequence: index + 1,
      })),
      session: baseSession({ scope: "owner", currentSequence: body.updates.length }),
    }));
    api.openSession = vi.fn(async () => baseSession({ scope: "owner", currentSequence: 1 }));
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "owner", token: TOKEN },
      baseSession({ scope: "owner" }),
      doc,
      { api, outbox, realtimeFactory: realtime.factory },
    );
    const fenced: boolean[] = [];
    provider.onWriteFence((value) => fenced.push(value));
    await provider.connect({ name: "Owner", color: "#123456" });
    doc.getText("content").insert(0, "durable");
    await provider.whenLocalUpdatesPersisted();
    await provider.flushNow();

    const preparing = provider.prepareEncryptionTransition();
    expect(fenced.at(-1)).toBe(true);
    doc.getText("content").insert(doc.getText("content").length, " raced");

    await expect(preparing).rejects.toThrow("document changed during encryption transition");
    expect(realtime.dispose).toHaveBeenCalledOnce();
    expect(api.sync).toHaveBeenCalledTimes(2);
    expect(await outbox.list(NOTE_ID, "owner", 1)).toEqual([]);
    expect(() => provider.assertEncryptionTransitionStable())
      .toThrow("document changed during encryption transition");
    await provider.destroy();
  });

  it("merges server updates even when their delivery order is reversed", async () => {
    const source = new Y.Doc();
    const updates: Uint8Array[] = [];
    source.on("update", (update) => updates.push(update));
    source.getText("content").insert(0, "A");
    source.getText("content").insert(1, "B");
    const rows = await Promise.all(updates.map(async (bytes, index) => ({
      updateId: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))), (byte) =>
        byte.toString(16).padStart(2, "0")).join(""),
      payload: encode(bytes),
      sequence: 2 - index,
      encryptionVersion: 0,
    })));
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession({ currentSequence: 2, missingUpdates: rows.reverse() }),
      doc,
      {
        api: apiHarness(),
        outbox: new CapabilityOutbox("snote-capability-provider-test"),
        realtimeFactory: realtimeHarness().factory,
      },
    );

    await provider.connect({ name: "Tester", color: "#123456" });

    expect(doc.getText("content").toString()).toBe("AB");
    await provider.destroy();
  });

  it("compacts acknowledged updates into a checkpoint with sequence and version CAS", async () => {
    const checkpointBodies: Array<Parameters<CapabilityApi["sync"]>[1]> = [];
    const realtime = lifecycleRealtimeHarness([]);
    let call = 0;
    const api = apiHarness(async (_token, body) => {
      call += 1;
      if (body.checkpoint) checkpointBodies.push(body);
      if (call === 1) {
        return {
          acknowledgements: body.updates.map((update) => ({ updateId: update.updateId, sequence: 1 })),
          session: baseSession({ currentSequence: 1 }),
        };
      }
      return {
        acknowledgements: [],
        session: pollingSession({
          currentSequence: 1,
          checkpointSequence: 1,
          checkpointVersion: 1,
          checkpointPayload: body.checkpoint?.payload ?? null,
          checkpointEncryptionVersion: 0,
        }),
      };
    });
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      doc,
      {
        api,
        outbox: new CapabilityOutbox("snote-capability-provider-test"),
        realtimeFactory: realtime.factory,
        compactionThresholdUpdates: 1,
      },
    );
    await provider.connect({ name: "Tester", color: "#123456" });

    doc.getText("content").insert(0, "durable checkpoint");
    await provider.whenLocalUpdatesPersisted();
    await provider.flushNow();

    expect(checkpointBodies).toHaveLength(1);
    expect(checkpointBodies[0].checkpoint).toMatchObject({
      throughSequence: 1,
      expectedCheckpointVersion: 0,
    });
    const restored = new Y.Doc();
    Y.applyUpdate(restored, decodeCapabilityPayload(checkpointBodies[0].checkpoint!.payload));
    expect(restored.getText("content").toString()).toBe("durable checkpoint");
    expect(provider.getSession().checkpointSequence).toBe(1);
    expect(realtime.handles[0].dispose).toHaveBeenCalledOnce();
    await provider.destroy();
  });

  it("refreshes checkpoint state after a concurrent compaction wins the CAS", async () => {
    const realtime = lifecycleRealtimeHarness([]);
    let call = 0;
    const api = apiHarness(async (_token, body) => {
      call += 1;
      if (call === 1) {
        return {
          acknowledgements: body.updates.map((update) => ({ updateId: update.updateId, sequence: 1 })),
          session: baseSession({ currentSequence: 1 }),
        };
      }
      throw new CapabilityApiError(
        "version conflict",
        409,
        null,
        "checkpoint_version_conflict",
      );
    });
    api.openSession = vi.fn(async () => pollingSession({
      currentSequence: 1,
      checkpointSequence: 1,
      checkpointVersion: 1,
    }));
    const doc = new Y.Doc();
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      baseSession(),
      doc,
      {
        api,
        outbox: new CapabilityOutbox("snote-capability-provider-test"),
        realtimeFactory: realtime.factory,
        compactionThresholdUpdates: 1,
      },
    );
    await provider.connect({ name: "Tester", color: "#123456" });
    doc.getText("content").insert(0, "concurrent checkpoint");
    await provider.whenLocalUpdatesPersisted();

    await provider.flushNow();

    expect(api.openSession).toHaveBeenCalledWith(TOKEN, 1);
    expect(provider.getSession().checkpointVersion).toBe(1);
    expect(realtime.handles[0].dispose).toHaveBeenCalledOnce();
    await provider.destroy();
  });

  it.each([
    [401, "unauthorized"],
    [409, "read_only"],
    [409, "checkpoint_encryption_conflict"],
  ])("fences a writer when checkpoint compaction receives terminal status %i/%s", async (status, code) => {
    const api = apiHarness(async (_token, body) => {
      if (body.checkpoint) {
        throw new CapabilityApiError(
          "capability revoked",
          status,
          null,
          code,
        );
      }
      return {
        acknowledgements: body.updates.map((update, index) => ({
          updateId: update.updateId,
          sequence: index + 1,
        })),
        session: pollingSession({ currentSequence: body.updates.length }),
      };
    });
    api.openSession = vi.fn(async () => pollingSession({ currentSequence: 1 }));
    const outbox = testOutbox(`snote-capability-compaction-terminal-${status}-${code}-test`);
    const provider = new CapabilityYjsProvider(
      { slug: "daily", scope: "edit", token: TOKEN },
      pollingSession(),
      new Y.Doc(),
      {
        api,
        outbox,
        realtimeFactory: vi.fn(async () => realtimeHandle()) as CapabilityRealtimeFactory,
        compactionThresholdUpdates: 1,
      },
    );
    const fences: boolean[] = [];
    provider.onWriteFence((value) => fences.push(value));

    try {
      await provider.connect({ name: "Editor", color: "#123456" });
      provider.doc.getText("content").insert(0, "checkpoint me");
      await provider.whenLocalUpdatesPersisted();
      await provider.flushNow();

      expect(fences.at(-1)).toBe(true);
      expect(api.openSession).not.toHaveBeenCalled();
      provider.doc.getText("content").insert(0, "must not queue");
      await provider.whenLocalUpdatesPersisted();
      expect(await outbox.list(NOTE_ID, "edit", 1)).toHaveLength(0);
    } finally {
      await provider.destroy();
    }
  });
});
