import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import {
  getSnapshotDebounceMs,
  SupabaseYjsProvider,
  type Encryption,
} from "../provider";
import { base64ToBytes, bytesToBase64 } from "../base64";
import { clearNoteEncryptionPin, markNoteEncrypted } from "@/lib/encryption-pin";

// Capture upsert calls so saveSnapshot tests can assert payloads.
const upsertCalls: Array<Record<string, unknown>> = [];
type BroadcastHandler = (message: { payload: unknown }) => void | Promise<void>;
type OutboundBroadcast = { event?: string; payload?: unknown; type?: string };
const broadcastHandlers = new Map<string, BroadcastHandler>();
const channelCreates: object[] = [];
const channelSendMock = vi.fn<(message: OutboundBroadcast) => Promise<void>>(async () => {});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      upsert: (payload: Record<string, unknown>) => {
        upsertCalls.push(payload);
        return Promise.resolve({ error: null });
      },
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
    }),
    channel: () => {
      const channel = {
        on: (
          _type: string,
          filter: { event?: string },
          handler: BroadcastHandler,
        ) => {
          if (filter.event) broadcastHandlers.set(filter.event, handler);
          return channel;
        },
        subscribe: async (handler: (status: string) => void | Promise<void>) => {
          await handler("SUBSCRIBED");
          return "SUBSCRIBED";
        },
        send: channelSendMock,
        unsubscribe: () => Promise.resolve(),
      };
      channelCreates.push(channel);
      return channel;
    },
    removeChannel: () => {},
  },
}));

// Polyfill rAF for jsdom — flush on next microtask tick.
beforeEach(() => {
  broadcastHandlers.clear();
  channelCreates.length = 0;
  channelSendMock.mockClear();
  localStorage.clear();
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    return setTimeout(() => cb(performance.now()), 0) as unknown as number;
  }) as typeof requestAnimationFrame;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeProvider(slug = "test-slug") {
  const doc = new Y.Doc();
  return makeProviderForDoc(slug, doc);
}

function makeProviderForDoc(slug: string, doc: Y.Doc) {
  const p = new SupabaseYjsProvider(slug, doc);
  return { provider: p, doc };
}

async function makeConnectedProvider(slug: string) {
  const doc = new Y.Doc();
  const provider = new SupabaseYjsProvider(slug, doc);
  provider.setExpectedEncrypted(false);
  await provider.connect(
    { name: "Tester", color: "#123456" },
    { prefetchedYdocState: null, rowExists: true },
  );
  channelSendMock.mockClear();
  return { provider, doc };
}

async function dispatchBroadcast(event: string, payload: unknown) {
  await broadcastHandlers.get(event)?.({ payload });
}

function sentEvents(event: string) {
  return channelSendMock.mock.calls.filter(
    ([message]) => (message as { event?: string }).event === event,
  );
}

describe("SupabaseYjsProvider — public broadcast containment", () => {
  beforeEach(() => {
    upsertCalls.length = 0;
  });

  it("ignores a forged slug-abandoned control event and keeps persistence active", async () => {
    const { provider, doc } = await makeConnectedProvider("forged-control");

    await dispatchBroadcast("slug-abandoned", { slug: "forged-control" });
    doc.getText("content").insert(0, "must persist");
    await provider.saveSnapshot();

    expect(upsertCalls.at(-1)?.content).toBe("must persist");
    await provider.destroy();
  });

  it("drops an oversized y-update before decoding or applying it", async () => {
    const { provider, doc } = await makeConnectedProvider("oversized-update");
    const remoteDoc = new Y.Doc();
    remoteDoc.getText("content").insert(0, "x".repeat(300_000));
    const oversized = bytesToBase64(Y.encodeStateAsUpdate(remoteDoc));

    await dispatchBroadcast("y-update", { update: oversized });

    expect(doc.getText("content").toString()).toBe("");
    await provider.destroy();
  });

  it("drops oversized awareness state instead of adding the remote client", async () => {
    const { provider } = await makeConnectedProvider("oversized-awareness");
    const remoteDoc = new Y.Doc();
    const remoteAwareness = new Awareness(remoteDoc);
    remoteAwareness.setLocalState({ user: { name: "x".repeat(70_000), color: "#000" } });
    const oversized = encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID]);

    await dispatchBroadcast("awareness", { update: bytesToBase64(oversized) });

    expect(provider.awareness.getStates().has(remoteDoc.clientID)).toBe(false);
    await provider.destroy();
  });

  it("rejects request-state payloads without a finite uint32 client id", async () => {
    const { provider } = await makeConnectedProvider("invalid-state-request");

    await dispatchBroadcast("request-state", { from: "attacker" });
    await dispatchBroadcast("request-state", { from: -1 });
    await dispatchBroadcast("request-state", { from: Number.NaN });

    expect(sentEvents("y-update")).toHaveLength(0);
    await provider.destroy();
  });

  it("throttles request-state responses to one full-state broadcast per second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { provider } = await makeConnectedProvider("state-request-throttle");

    await dispatchBroadcast("request-state", { from: 101 });
    await dispatchBroadcast("request-state", { from: 102 });
    await dispatchBroadcast("request-state", { from: 103 });
    expect(sentEvents("y-update")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await dispatchBroadcast("request-state", { from: 104 });
    expect(sentEvents("y-update")).toHaveLength(2);

    await provider.destroy();
    vi.useRealTimers();
  });
});

describe("SupabaseYjsProvider — teardown durability", () => {
  beforeEach(() => {
    upsertCalls.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes a pending plaintext edit before ordinary teardown", async () => {
    const { provider, doc } = makeProvider("some-slug");
    provider.setExpectedEncrypted(false);

    doc.getText("content").insert(0, "draft");
    await Promise.all([provider.destroy(), provider.destroy()]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({
      slug: "some-slug",
      content: "draft",
      char_count: 5,
      is_encrypted: false,
    });
  });

  it("flushes a pending encrypted edit before ordinary teardown", async () => {
    const slug = "encrypted-navigation";
    const { provider, doc } = makeProvider(slug);
    expect(markNoteEncrypted(slug)).toBe(true);
    provider.setEncryption({
      encrypt: async (bytes) => bytes,
      decrypt: async (bytes) => bytes,
    });
    provider.setExpectedEncrypted(true);

    doc.getText("content").insert(0, "secret draft");
    await provider.destroy();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({
      slug,
      content: "",
      char_count: 0,
      tags: [],
      is_encrypted: true,
    });
  });

  it("does not resurrect an abandoned slug during teardown", async () => {
    const { provider, doc } = makeProvider("abandoned-slug");
    provider.setExpectedEncrypted(false);

    doc.getText("content").insert(0, "must not return");
    provider.markAbandoned();
    await provider.destroy();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(upsertCalls).toHaveLength(0);
  });

  it("finishes an older save before the teardown save so stale bytes cannot win", async () => {
    const slug = "ordered-encrypted-save";
    const { provider, doc } = makeProvider(slug);
    expect(markNoteEncrypted(slug)).toBe(true);

    let resolveFirstEncryption!: () => void;
    let encryptionCalls = 0;
    provider.setEncryption({
      encrypt: vi.fn(async (bytes) => {
        encryptionCalls += 1;
        if (encryptionCalls === 1) {
          return new Promise<Uint8Array>((resolve) => {
            resolveFirstEncryption = () => resolve(bytes);
          });
        }
        return bytes;
      }),
      decrypt: async (bytes) => bytes,
    });
    provider.setExpectedEncrypted(true);

    const text = doc.getText("content");
    text.insert(0, "first");
    const olderSave = provider.saveSnapshot();
    await vi.waitFor(() => expect(encryptionCalls).toBe(1));

    text.insert(text.length, " second");
    const closing = provider.destroy();
    resolveFirstEncryption();
    await Promise.all([olderSave, closing]);

    expect(upsertCalls).toHaveLength(2);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, base64ToBytes(String(upsertCalls.at(-1)?.ydoc_state)));
    expect(restored.getText("content").toString()).toBe("first second");
    expect(provider.hasUnflushedLocalChanges()).toBe(false);
  });

  it("orders teardown saves across rapid remounts of the same cached document", async () => {
    const slug = "rapid-remount-encrypted";
    const doc = new Y.Doc();
    const { provider: firstProvider } = makeProviderForDoc(slug, doc);
    expect(markNoteEncrypted(slug)).toBe(true);

    let resolveFirstEncryption!: () => void;
    let firstProviderEncryptionCalls = 0;
    firstProvider.setEncryption({
      encrypt: vi.fn((bytes) => {
        firstProviderEncryptionCalls += 1;
        if (firstProviderEncryptionCalls > 1) return Promise.resolve(bytes);
        return new Promise<Uint8Array>((resolve) => {
          resolveFirstEncryption = () => resolve(bytes);
        });
      }),
      decrypt: async (bytes) => bytes,
    });
    firstProvider.setExpectedEncrypted(true);

    const text = doc.getText("content");
    text.insert(0, "first");
    const firstSave = firstProvider.saveSnapshot();
    await vi.waitFor(() => expect(resolveFirstEncryption).toBeTypeOf("function"));
    const firstClosing = firstProvider.destroy();

    const { provider: secondProvider } = makeProviderForDoc(slug, doc);
    secondProvider.setEncryption({
      encrypt: async (bytes) => bytes,
      decrypt: async (bytes) => bytes,
    });
    secondProvider.setExpectedEncrypted(true);
    text.insert(text.length, " second");
    const secondClosing = secondProvider.destroy();

    resolveFirstEncryption();
    await Promise.all([firstSave, firstClosing, secondClosing]);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, base64ToBytes(String(upsertCalls.at(-1)?.ydoc_state)));
    expect(restored.getText("content").toString()).toBe("first second");
  });
});


describe("getSnapshotDebounceMs", () => {
  afterEach(() => {
    localStorage.removeItem("syrin:yjs-snapshot-debounce-ms");
  });

  it("accepts a runtime debounce override for E2E stress runs", () => {
    localStorage.setItem("syrin:yjs-snapshot-debounce-ms", "37");

    expect(getSnapshotDebounceMs()).toBe(37);
  });
});


describe("SupabaseYjsProvider — Phase 2.5 broadcast batching", () => {
  it("batches multiple updates into 1 broadcast per rAF", async () => {
    const { provider, doc } = makeProvider();
    const text = doc.getText("content");
    // 30 separate Y.Doc transactions → 30 handleDocUpdate calls.
    for (let i = 0; i < 30; i++) {
      text.insert(text.length, "a");
    }
    expect(provider.getUpdateCount()).toBe(30);
    expect(provider.getBroadcastCount()).toBe(0); // not flushed yet
    // Flush rAF.
    await new Promise((r) => setTimeout(r, 5));
    expect(provider.getBroadcastCount()).toBe(1);
  });

  it("eager-flushes at MAX_PENDING_UPDATES (50) to bound memory", async () => {
    const { provider, doc } = makeProvider();
    const text = doc.getText("content");
    // 100 updates → 1 eager flush at 50, 1 eager flush at 100 (50 more
    // arrive synchronously, hitting the threshold again before rAF).
    for (let i = 0; i < 100; i++) {
      text.insert(text.length, "a");
    }
    expect(provider.getUpdateCount()).toBe(100);
    // Two eager flushes triggered synchronously inside the loop.
    expect(provider.getBroadcastCount()).toBe(2);
    // No additional rAF flush since queue is empty.
    await new Promise((r) => setTimeout(r, 5));
    expect(provider.getBroadcastCount()).toBe(2);
  });
});

describe("SupabaseYjsProvider — connect idempotency (F1)", () => {
  it("treats a second connect on a live provider as a no-op", async () => {
    const { provider } = makeProvider("connect-once");
    provider.setExpectedEncrypted(false);

    await provider.connect(
      { name: "First", color: "#111111" },
      { prefetchedYdocState: null, rowExists: true },
    );
    await provider.connect(
      { name: "Ghost", color: "#222222" },
      { prefetchedYdocState: null, rowExists: true },
    );

    expect(channelCreates).toHaveLength(1);
    expect(provider.awareness.getLocalState()?.user).toEqual({
      name: "First",
      color: "#111111",
    });
    await provider.destroy();
  });

  it("joins an in-flight connect instead of opening a second channel", async () => {
    const { provider } = makeProvider("connect-inflight");
    provider.setExpectedEncrypted(false);

    const first = provider.connect(
      { name: "First", color: "#111111" },
      { prefetchedYdocState: null, rowExists: true },
    );
    const second = provider.connect(
      { name: "Ghost", color: "#222222" },
      { prefetchedYdocState: null, rowExists: true },
    );
    await Promise.all([first, second]);

    expect(channelCreates).toHaveLength(1);
    expect(provider.awareness.getLocalState()?.user).toEqual({
      name: "First",
      color: "#111111",
    });
    await provider.destroy();
  });
});

describe("SupabaseYjsProvider — connection lifecycle", () => {
  it("tracks an encrypted local edit made while the initial snapshot is decrypting", async () => {
    const slug = "edit-during-decrypt";
    const remoteDoc = new Y.Doc();
    remoteDoc.getText("content").insert(0, "remote");
    const encryptedSnapshot = bytesToBase64(Y.encodeStateAsUpdate(remoteDoc));
    expect(markNoteEncrypted(slug)).toBe(true);

    let resolveDecryptStarted!: () => void;
    const decryptStarted = new Promise<void>((resolve) => {
      resolveDecryptStarted = resolve;
    });
    let finishDecrypt!: () => void;
    const doc = new Y.Doc();
    const provider = new SupabaseYjsProvider(slug, doc);
    provider.setEncryption({
      encrypt: async (bytes) => bytes,
      decrypt: (bytes) => {
        resolveDecryptStarted();
        return new Promise<Uint8Array>((resolve) => {
          finishDecrypt = () => resolve(bytes);
        });
      },
    });
    provider.setExpectedEncrypted(true);

    const connecting = provider.connect(
      { name: "Tester", color: "#123456" },
      { prefetchedYdocState: encryptedSnapshot, rowExists: true },
    );
    await decryptStarted;
    doc.getText("content").insert(0, "local");
    finishDecrypt();
    await connecting;

    expect(provider.hasUnflushedLocalChanges()).toBe(true);
    await provider.destroy();
    expect(upsertCalls.at(-1)?.is_encrypted).toBe(true);
  });
});

describe("SupabaseYjsProvider — SyncEvent lifecycle", () => {
  it("emits 'offline' to subscribed listeners", () => {
    const { provider } = makeProvider();
    const events: string[] = [];
    provider.onSyncEvent((e) => events.push(e.type));
    (provider as unknown as { emitSync: (e: { type: string }) => void }).emitSync({ type: "offline" });
    expect(events).toContain("offline");
  });

  it("emits 'online' to subscribed listeners", () => {
    const { provider } = makeProvider();
    const events: string[] = [];
    provider.onSyncEvent((e) => events.push(e.type));
    (provider as unknown as { emitSync: (e: { type: string }) => void }).emitSync({ type: "online" });
    expect(events).toContain("online");
  });

  it("emits 'error' with message payload", () => {
    const { provider } = makeProvider();
    const events: { type: string; message?: string }[] = [];
    provider.onSyncEvent((e) => events.push({ type: e.type, message: (e as { message?: string }).message }));
    (provider as unknown as { emitSync: (e: { type: string; message: string }) => void })
      .emitSync({ type: "error", message: "upsert failed" });
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err?.message).toBe("upsert failed");
  });

  it("unsubscribe stops further deliveries", () => {
    const { provider } = makeProvider();
    const events: string[] = [];
    const unsub = provider.onSyncEvent((e) => events.push(e.type));
    unsub();
    (provider as unknown as { emitSync: (e: { type: string }) => void }).emitSync({ type: "offline" });
    expect(events).toHaveLength(0);
  });
});

describe("SupabaseYjsProvider — saveSnapshot encryption consistency", () => {
  beforeEach(() => {
    upsertCalls.length = 0;
  });

  it("persists is_encrypted=false when provider has no encryption", async () => {
    const { provider, doc } = makeProvider();
    provider.setExpectedEncrypted(false);
    doc.getText("content").insert(0, "hello");
    await provider.saveSnapshot();
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].is_encrypted).toBe(false);
    expect(upsertCalls[0].content).toBe("hello");
  });

  it("persists is_encrypted=true and blanks content when encryption is set", async () => {
    const { provider, doc } = makeProvider();
    const enc: Encryption = {
      encrypt: async (b) => b,
      decrypt: async (b) => b,
    };
    expect(markNoteEncrypted("test-slug")).toBe(true);
    provider.setEncryption(enc);
    provider.setExpectedEncrypted(true);
    doc.getText("content").insert(0, "secret");
    await provider.saveSnapshot();
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].is_encrypted).toBe(true);
    expect(upsertCalls[0].content).toBe("");
    expect(upsertCalls[0].char_count).toBe(0);
    expect(upsertCalls[0].tags).toEqual([]);
  });

  it("skips write when local encryption mode disagrees with stored mode", async () => {
    const { provider, doc } = makeProvider();
    doc.getText("content").insert(0, "plaintext");
    // Row is encrypted, but provider has no key — must NOT overwrite.
    provider.setExpectedEncrypted(true);
    await provider.saveSnapshot();
    expect(upsertCalls).toHaveLength(0);
  });

  it("skips flushBeacon when encryption mode mismatches", () => {
    const { provider, doc } = makeProvider();
    doc.getText("content").insert(0, "plaintext");
    provider.setExpectedEncrypted(true);
    const beacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    provider.flushBeacon();
    expect(beacon).not.toHaveBeenCalled();
  });
});

describe("SupabaseYjsProvider — rapid lock/unlock toggle regression", () => {
  beforeEach(() => {
    upsertCalls.length = 0;
  });

  it("stale plaintext provider cannot write after row flips to encrypted", async () => {
    // Simulates: user locks note via URL hash → enc-meta refetch marks the
    // still-mounted plaintext provider as expected=encrypted BEFORE the new
    // provider mounts. The stale instance must be blocked from writing.
    const { provider: stale, doc } = makeProvider();
    doc.getText("content").insert(0, "typed after lock");
    stale.setExpectedEncrypted(true);
    await stale.saveSnapshot();
    stale.flushBeacon();
    expect(upsertCalls).toHaveLength(0);
  });

  it("stale encrypted provider cannot write after row flips to plaintext", async () => {
    const { provider: stale, doc } = makeProvider();
    stale.setEncryption({ encrypt: async (b) => b, decrypt: async (b) => b });
    doc.getText("content").insert(0, "still encrypting");
    stale.setExpectedEncrypted(false);
    await stale.saveSnapshot();
    expect(upsertCalls).toHaveLength(0);
  });

  it("rapid toggles: only the provider matching current mode persists", async () => {
    const a = makeProvider(); // was plaintext, row is now encrypted
    a.doc.getText("content").insert(0, "a");
    a.provider.setExpectedEncrypted(true);

    const b = makeProvider(); // was encrypted, row is now plaintext
    b.provider.setEncryption({ encrypt: async (x) => x, decrypt: async (x) => x });
    b.doc.getText("content").insert(0, "b");
    b.provider.setExpectedEncrypted(false);

    const c = makeProvider(); // current mode = plaintext, matches
    c.doc.getText("content").insert(0, "c");
    c.provider.setExpectedEncrypted(false);

    await Promise.all([
      a.provider.saveSnapshot(),
      b.provider.saveSnapshot(),
      c.provider.saveSnapshot(),
    ]);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].content).toBe("c");
    expect(upsertCalls[0].is_encrypted).toBe(false);
  });

  it("stops every outbound content path when a plaintext provider observes a durable encrypted pin", async () => {
    const slug = "stale-plaintext-pin";
    const { provider, doc } = await makeConnectedProvider(slug);
    const beacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });

    expect(markNoteEncrypted(slug)).toBe(true);
    doc.getText("content").insert(0, "must stay local");
    await new Promise((resolve) => setTimeout(resolve, 5));
    provider.cancelPendingSnapshot();
    await provider.saveSnapshot();
    provider.flushBeacon();

    expect(sentEvents("y-update")).toHaveLength(0);
    expect(upsertCalls).toHaveLength(0);
    expect(beacon).not.toHaveBeenCalled();
    await provider.destroy();
  });

  it("stops every outbound content path when an encrypted provider observes its durable pin cleared", async () => {
    const slug = "stale-encrypted-pin";
    expect(markNoteEncrypted(slug)).toBe(true);
    const { provider, doc } = await makeConnectedProvider(slug);
    provider.setEncryption({ encrypt: async (bytes) => bytes, decrypt: async (bytes) => bytes });
    provider.setExpectedEncrypted(true);
    const beacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });

    expect(clearNoteEncryptionPin(slug)).toBe(true);
    doc.getText("content").insert(0, "must stay encrypted locally");
    await new Promise((resolve) => setTimeout(resolve, 5));
    provider.cancelPendingSnapshot();
    await provider.saveSnapshot();
    provider.flushBeacon();

    expect(sentEvents("y-update")).toHaveLength(0);
    expect(upsertCalls).toHaveLength(0);
    expect(beacon).not.toHaveBeenCalled();
    await provider.destroy();
  });

  it("rechecks the durable pin immediately before queueing a plaintext beacon", () => {
    const slug = "beacon-pin-race";
    const { provider, doc } = makeProvider(slug);
    provider.setExpectedEncrypted(false);
    doc.getText("content").insert(0, "must not beacon");
    provider.cancelPendingSnapshot();
    const beacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    const NativeBlob = Blob;
    vi.stubGlobal("Blob", class extends NativeBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        markNoteEncrypted(slug);
        super(parts, options);
      }
    });

    provider.flushBeacon();

    expect(beacon).not.toHaveBeenCalled();
  });

  it("rechecks the durable pin before falling back from a rejected beacon to fetch", () => {
    const slug = "beacon-fetch-pin-race";
    const { provider, doc } = makeProvider(slug);
    provider.setExpectedEncrypted(false);
    doc.getText("content").insert(0, "must not fetch");
    provider.cancelPendingSnapshot();
    const beacon = vi.fn().mockImplementation(() => {
      markNoteEncrypted(slug);
      return false;
    });
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    provider.flushBeacon();

    expect(beacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
