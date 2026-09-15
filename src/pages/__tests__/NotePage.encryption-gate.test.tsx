import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense, type ReactNode } from "react";
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import NotePage from "../NotePage";
import SharePage from "../SharePage";
import {
  clearNoteEncryptionPin,
  getEncryptionPinState,
  markNoteEncrypted,
} from "@/lib/encryption-pin";
import type {
  PollingNoteSession,
  PrivateRealtimeNoteSession,
} from "@/lib/capability/client";

const harness = vi.hoisted(() => ({
  editorRender: vi.fn(),
  previewRender: vi.fn(),
  unlockRender: vi.fn(),
  unlockProps: vi.fn(),
  idbConstruct: vi.fn(),
  upsertPlaintextNote: vi.fn(),
  docAcquire: vi.fn(),
  docRelease: vi.fn(),
  providerConstruct: vi.fn(),
  providerConnect: vi.fn(),
  providerDestroy: vi.fn(),
  capabilityProviderConstruct: vi.fn(),
  capabilityProviderConnect: vi.fn(),
  capabilityProviderDestroy: vi.fn(),
  maybeSaveSnapshot: vi.fn(),
  recordOnSuddenDelete: vi.fn(),
  topbarProps: vi.fn(),
  capabilityOpenSession: vi.fn(),
  metaForSlug: vi.fn(),
  notesFrom: vi.fn(),
  deriveKey: vi.fn(),
  verifyCheck: vi.fn(),
  decryptBytes: vi.fn(),
  shareInvoke: vi.fn(),
  toast: vi.fn(),
  persistPlain: null as null | (() => void),
  upsertFn: null as null | ((body: unknown, keepalive?: boolean) => Promise<unknown>),
  onManaged: null as null | (() => void),
  convertPlainNoteOnWrite: vi.fn<(...args: unknown[]) => Promise<string>>(async () => {
    throw new Error("convert-on-write is mocked in this harness");
  }),
  hasStoredConvertRecovery: vi.fn<(...args: unknown[]) => boolean>(() => false),
  upsertPlainNote: vi.fn<(...args: unknown[]) => Promise<{ noteId: string; created: boolean }>>(
    async () => ({ noteId: "n", created: true }),
  ),
  disableSecureNote: vi.fn<(...args: unknown[]) => Promise<{ noteId: string; recovered: boolean }>>(
    async () => ({ noteId: "n", recovered: false }),
  ),
  translate: (key: string) => key,
  metaPromise: Promise.resolve({ data: null as Record<string, unknown> | null }),
}));

vi.mock("@/components/note/Editor", async () => {
  const { forwardRef } = await vi.importActual<typeof import("react")>("react");
  return {
    Editor: forwardRef(function Editor() {
      harness.editorRender();
      return <div data-testid="editor" />;
    }),
  };
});
vi.mock("@/components/note/Preview", () => ({
  Preview: () => {
    harness.previewRender();
    return <div data-testid="preview" />;
  },
}));
vi.mock("@/components/note/UnlockForm", () => ({
  UnlockForm: (props: {
    slug: string;
    salt: string;
    check: string;
    iterations: number;
    onUnlock: (key: CryptoKey) => void;
  }) => {
    harness.unlockRender(props.slug);
    harness.unlockProps(props);
    return <div role="dialog" aria-label={`Unlock encrypted note ${props.slug}`} />;
  },
}));
vi.mock("@/components/note/EditorSkeleton", () => ({ EditorSkeleton: () => <div data-testid="skeleton" /> }));
vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
vi.mock("@/components/note/Topbar", () => ({
  Topbar: (props: { allowEncryptionTransitions?: boolean }) => {
    harness.topbarProps(props);
    return null;
  },
}));
vi.mock("@/components/note/PageIndicator", () => ({ PageIndicator: () => null }));
vi.mock("@/components/note/GoalConfetti", () => ({ GoalConfetti: () => null }));
vi.mock("@/components/note/OutlineSidebar", () => ({ OutlineSidebar: () => null }));
vi.mock("@/components/app/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-helmet-async", () => ({ Helmet: () => null }));
vi.mock("lucide-react", () => ({
  ArrowLeft: () => null,
  Eye: () => null,
  KeyRound: () => null,
  Loader2: () => <span aria-label="Loading encryption metadata" />,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: (...args: unknown[]) => harness.shareInvoke(...args),
    },
    from: (table: string) => {
      harness.notesFrom(table);
      return {
        select: () => ({
          eq: (_column: string, slug: string) => ({ maybeSingle: () => harness.metaForSlug(slug) }),
        }),
      };
    },
  },
}));
vi.mock("@/lib/capability/client", () => ({
  createCapabilityApi: () => ({
    openSession: (...args: unknown[]) => harness.capabilityOpenSession(...args),
    upsertPlainNote: (...args: unknown[]) => harness.upsertPlainNote(...args),
    disableSecureNote: (...args: unknown[]) => harness.disableSecureNote(...args),
  }),
}));
vi.mock("@/lib/yjs/doc-cache", () => ({
  acquireDoc: (slug: string) => {
    harness.docAcquire(slug);
    return {
      getText: () => ({
        toString: () => "",
        insert: vi.fn(),
        observe: vi.fn(),
        unobserve: vi.fn(),
      }),
    };
  },
  releaseDoc: (slug: string) => harness.docRelease(slug),
}));
vi.mock("@/lib/yjs/provider", () => ({
  SupabaseYjsProvider: class {
    awareness = {};
    private destroyed = false;

    constructor(private readonly slug: string) {
      harness.providerConstruct(slug);
    }

    setEncryption() {}
    setExpectedEncrypted() {}
    onAwareness() { return vi.fn(); }
    onSyncEvent() { return vi.fn(); }
    connect() {
      if (this.destroyed) return Promise.resolve();
      harness.providerConnect(this.slug);
      return Promise.resolve();
    }
    flushBeacon() {}
    destroy() {
      this.destroyed = true;
      harness.providerDestroy(this.slug);
      return Promise.resolve();
    }
  },
}));
vi.mock("@/lib/yjs/capability-provider", () => ({
  CapabilityYjsProvider: class {
    awareness = {};
    private destroyed = false;

    constructor(
      private readonly access: unknown,
      private readonly session: unknown,
      private readonly doc: unknown,
      private readonly dependencies: unknown,
    ) {
      harness.capabilityProviderConstruct(access, session, doc, dependencies);
    }

    setEncryption() {}
    setExpectedEncrypted() {}
    onAwareness() { return vi.fn(); }
    onSyncEvent() { return vi.fn(); }
    connect() {
      if (this.destroyed) return Promise.resolve();
      harness.capabilityProviderConnect(this.access, this.session, this.doc);
      return Promise.resolve();
    }
    flushBeacon() {}
    destroy() {
      this.destroyed = true;
      harness.capabilityProviderDestroy(this.access, this.session, this.doc);
      return Promise.resolve();
    }
  },
}));
vi.mock("@/lib/yjs/plain-upsert-provider", () => ({
  PlainUpsertProvider: class {
    awareness = {};
    private destroyed = false;

    constructor(
      private readonly slug: string,
      _doc: unknown,
      upsert: (body: unknown, keepalive?: boolean) => Promise<unknown>,
      onManaged: () => void,
    ) {
      harness.providerConstruct(slug);
      harness.upsertFn = upsert;
      harness.onManaged = onManaged;
    }

    setEncryption() {}
    setExpectedEncrypted() {}
    onAwareness() { return vi.fn(); }
    onSyncEvent() { return vi.fn(); }
    connect() {
      if (this.destroyed) return Promise.resolve();
      harness.providerConnect(this.slug);
      return Promise.resolve();
    }
    flushBeacon() {}
    destroy() {
      this.destroyed = true;
      harness.providerDestroy(this.slug);
      return Promise.resolve();
    }
  },
}));
vi.mock("@/lib/yjs/local-convert-provider", () => ({
  LocalConvertProvider: class {
    awareness = {};
    private destroyed = false;

    constructor(
      private readonly slug: string,
      _doc: unknown,
      onFirstPersist: () => void,
    ) {
      harness.providerConstruct(slug);
      harness.persistPlain = onFirstPersist;
    }

    setEncryption() {}
    setExpectedEncrypted() {}
    onAwareness() { return vi.fn(); }
    onSyncEvent() { return vi.fn(); }
    connect() {
      if (this.destroyed) return Promise.resolve();
      harness.providerConnect(this.slug);
      return Promise.resolve();
    }
    flushBeacon() {}
    destroy() {
      this.destroyed = true;
      harness.providerDestroy(this.slug);
      return Promise.resolve();
    }
  },
}));
vi.mock("@/lib/legacy/cutover", () => ({
  createLegacyNoteApi: () => ({
    open: async (slug: string) => {
      const result = await harness.metaForSlug(slug);
      if (result && typeof result === "object" && "error" in result && (result as { error?: unknown }).error) {
        throw (result as { error: unknown }).error;
      }
      if (result && typeof result === "object" && "managed" in result && (result as { managed?: boolean }).managed) {
        throw { code: "capability_managed", status: 409, name: "CapabilityManagedError" };
      }
      const data = (result as { data?: Record<string, unknown> | null } | null)?.data;
      if (!data) {
        return null;
      }
      return {
        slug,
        content: typeof data.content === "string" ? data.content : "",
        ydocState: typeof data.ydoc_state === "string" ? data.ydoc_state : "",
        isEncrypted: Boolean(data.is_encrypted),
        salt: typeof data.enc_salt === "string" ? data.enc_salt : null,
        check: typeof data.enc_check === "string" ? data.enc_check : null,
        iterations: typeof data.enc_iterations === "number" ? data.enc_iterations : null,
      };
    },
  }),
  CapabilityManagedError: class CapabilityManagedError extends Error {
    code = "capability_managed";
    status = 409;
    constructor() {
      super("capability managed");
      this.name = "CapabilityManagedError";
    }
  },
  mapDuplicateFailure: (error: unknown) => {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : null;
    if (
      code === "slug_unavailable"
      || code === "converted_slug_unrecoverable"
      || code === "capability_managed"
    ) {
      return "converted";
    }
    return "retry";
  },
}));
vi.mock("@/lib/legacy/convert-on-write", () => ({
  convertPlainNoteOnWrite: (...args: unknown[]) => harness.convertPlainNoteOnWrite(...args),
  consumeConvertSeed: () => null,
  hasStoredConvertRecovery: (...args: unknown[]) => harness.hasStoredConvertRecovery(...args),
}));
vi.mock("@/hooks/use-word-goal", () => ({ useWordGoal: () => ({ goal: null }), consumeGoalReached: () => false }));
vi.mock("@/hooks/use-toast", () => ({ toast: (...args: unknown[]) => harness.toast(...args) }));
vi.mock("@/hooks/use-zen-mode", () => ({ useZenMode: () => ({ zen: false, toggle: vi.fn() }) }));
vi.mock("@/hooks/use-typewriter-mode", () => ({ useTypewriterMode: () => ({ typewriter: false, toggle: vi.fn() }) }));
vi.mock("@/hooks/use-preview-visible", () => ({ usePreviewVisible: () => ({ visible: true, setVisible: vi.fn() }) }));
vi.mock("@/hooks/use-narrow-viewport", () => ({ useNarrowViewport: () => false }));
vi.mock("@/hooks/use-scroll-sync-enabled", () => ({ useScrollSyncEnabled: () => ({ enabled: false, toggle: vi.fn() }) }));
vi.mock("@/hooks/use-scroll-sync", () => ({ useScrollSync: vi.fn() }));
vi.mock("@/hooks/use-focus-line", () => ({ useFocusLine: () => ({ focusLine: false, toggle: vi.fn() }) }));
vi.mock("@/hooks/use-eink", () => ({ useEink: vi.fn() }));
vi.mock("@/hooks/use-vim-mode", () => ({ useVimMode: () => ({ vim: false }) }));
vi.mock("@/hooks/use-pagination", () => ({
  usePagination: () => ({ enabled: false, toggle: vi.fn(), flip: vi.fn(), page: 1, totalPages: 1 }),
}));
vi.mock("@/i18n", () => ({ useI18n: () => ({ t: harness.translate }) }));
vi.mock("@/i18n/index", () => ({ useI18n: () => ({ t: harness.translate }) }));
vi.mock("@/lib/crypto", () => ({
  deriveKey: harness.deriveKey,
  encryptBytes: vi.fn(),
  decryptBytes: harness.decryptBytes,
  verifyCheck: harness.verifyCheck,
  iterationsFor: () => 1,
}));
vi.mock("@/lib/yjs/base64", () => ({ base64ToBytes: () => new Uint8Array([1]) }));
vi.mock("@/hooks/use-scene-theme", () => ({ useSceneTheme: () => ({ scene: "none" }) }));
vi.mock("@/lib/recent-notes", () => ({ touchRecent: vi.fn() }));
vi.mock("@/lib/snapshots", () => ({
  maybeSaveSnapshot: harness.maybeSaveSnapshot,
  recordOnSuddenDelete: harness.recordOnSuddenDelete,
}));
vi.mock("@/lib/yjs/identity", () => ({ getIdentity: () => ({ name: "Test", color: "#000" }) }));
vi.mock("@/lib/wiki-link", () => ({ WIKI_NAV_EVENT: "wiki-nav" }));
vi.mock("@/lib/note-index", () => ({
  hydrateNoteIndex: () => Promise.resolve(),
  rememberMetadata: () => {},
  upsertPlaintextNote: (...args: unknown[]) => harness.upsertPlaintextNote(...args),
}));
vi.mock("@/lib/ext-context", () => ({ isExtensionContext: false }));
vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: class {
    whenSynced = Promise.resolve();

    constructor(name: string) {
      harness.idbConstruct(name);
    }

    destroy() {}
  },
}));

function renderEmbedded() {
  return render(
    <MemoryRouter>
      <NotePage embedSlug="secret" />
    </MemoryRouter>,
  );
}

function renderStandalone() {
  return render(
    <MemoryRouter
      initialEntries={["/secret"]}
    >
      <Routes>
        <Route path="/:slug" element={<NotePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const CAPABILITY_TOKEN = "a".repeat(43);
const CAPABILITY_TOKEN_B = "b".repeat(43);
const NOTE_ID = "00000000-0000-4000-8000-000000000001";

function pollingSession(
  overrides: Partial<PollingNoteSession> = {},
): PollingNoteSession {
  return {
    noteId: NOTE_ID,
    slug: "secret",
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
    syncTransport: "polling",
    realtimeToken: null,
    realtimeExpiresAt: null,
    ...overrides,
  };
}

function privateRealtimeSession(
  overrides: Partial<PrivateRealtimeNoteSession> = {},
): PrivateRealtimeNoteSession {
  const polling = pollingSession();
  return {
    ...polling,
    syncTransport: "private-realtime",
    realtimeToken: "private-realtime-token",
    realtimeExpiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderCapability(scope: "owner" | "edit") {
  return render(
    <MemoryRouter initialEntries={[`/secret#${scope}=${CAPABILITY_TOKEN}`]}>
      <Routes>
        <Route path="/:slug" element={<NotePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function CapabilityNavigationHarness() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate("/secret")}>
        navigate-legacy
      </button>
      <button type="button" onClick={() => navigate(`/secret#owner=${CAPABILITY_TOKEN}`)}>
        navigate-owner
      </button>
      <button
        type="button"
        onClick={() => navigate(`/secret#edit=${CAPABILITY_TOKEN_B}`)}
      >
        navigate-capability-b
      </button>
      <Routes>
        <Route path="/:slug" element={<NotePage />} />
      </Routes>
    </>
  );
}

function renderCapabilityNavigation(initialEntry = `/secret#owner=${CAPABILITY_TOKEN}`) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <CapabilityNavigationHarness />
    </MemoryRouter>,
  );
}

const SHARE_TOKEN_A = "aaaaaaaaaaaaaaaa";
const SHARE_TOKEN_B = "bbbbbbbbbbbbbbbb";

function ShareRouteHarness() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate(`/s/${SHARE_TOKEN_B}`)}>
        navigate-share-b
      </button>
      <button
        type="button"
        onClick={() => {
          window.history.replaceState(
            null,
            "",
            `/s/${SHARE_TOKEN_A}#router-key`,
          );
          navigate(`/s/${SHARE_TOKEN_A}#router-key`);
        }}
      >
        navigate-share-hash
      </button>
      <Routes>
        <Route path="/s/:token" element={<SharePage />} />
      </Routes>
    </>
  );
}

function renderShareRoute() {
  return render(
    <MemoryRouter
      initialEntries={[`/s/${SHARE_TOKEN_A}`]}
    >
      <ShareRouteHarness />
    </MemoryRouter>,
  );
}

function encryptedShareResponse(label: string) {
  return {
    data: {
      content: "",
      ydoc_state: `ciphertext-${label}`,
      is_encrypted: true,
      enc_salt: `salt-${label}`,
      enc_check: `check-${label}`,
      enc_iterations: 1,
      updated_at: "2026-07-19T00:00:00.000Z",
    },
    error: null,
  };
}

describe("NotePage encryption gate", () => {
  beforeEach(() => {
    harness.editorRender.mockClear();
    harness.previewRender.mockClear();
    harness.unlockRender.mockClear();
    harness.unlockProps.mockClear();
    harness.idbConstruct.mockClear();
    harness.upsertPlaintextNote.mockClear();
    harness.docAcquire.mockClear();
    harness.docRelease.mockClear();
    harness.providerConstruct.mockClear();
    harness.providerConnect.mockClear();
    harness.providerDestroy.mockClear();
    harness.capabilityProviderConstruct.mockClear();
    harness.capabilityProviderConnect.mockClear();
    harness.capabilityProviderDestroy.mockClear();
    harness.maybeSaveSnapshot.mockClear();
    harness.recordOnSuddenDelete.mockClear();
    harness.topbarProps.mockClear();
    harness.capabilityOpenSession.mockReset();
    harness.capabilityOpenSession.mockResolvedValue(null);
    harness.metaForSlug.mockReset();
    harness.metaForSlug.mockImplementation(() => harness.metaPromise);
    harness.notesFrom.mockReset();
    harness.deriveKey.mockReset();
    harness.verifyCheck.mockReset();
    harness.decryptBytes.mockReset();
    harness.shareInvoke.mockReset();
    harness.toast.mockReset();
    harness.persistPlain = null;
    harness.upsertFn = null;
    harness.onManaged = null;
    harness.convertPlainNoteOnWrite.mockReset();
    harness.convertPlainNoteOnWrite.mockImplementation(async () => {
      throw new Error("convert-on-write is mocked in this harness");
    });
    harness.hasStoredConvertRecovery.mockReset();
    harness.hasStoredConvertRecovery.mockReturnValue(false);
    harness.upsertPlainNote.mockReset();
    harness.upsertPlainNote.mockResolvedValue({ noteId: "n", created: true });
    harness.disableSecureNote.mockReset();
    harness.disableSecureNote.mockResolvedValue({ noteId: "n", recovered: false });
    harness.translate = (key: string) => key;
    localStorage.clear();
    window.history.replaceState(null, "", window.location.pathname);
  });

  it("keeps capability-shaped fragments on the deployed legacy backend in legacy-only mode", async () => {
    harness.metaForSlug.mockResolvedValue({
      data: { is_encrypted: false },
      error: null,
    });
    const token = "a".repeat(43);
    render(
      <MemoryRouter initialEntries={[`/secret#owner=${token}&key=safe%20key`]}>
        <Routes>
          <Route path="/:slug" element={<NotePage legacyOnly />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(harness.metaForSlug).toHaveBeenCalledWith("secret"));
    expect(harness.notesFrom).toHaveBeenCalledWith("notes");
    expect(harness.capabilityOpenSession).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(harness.topbarProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          allowEncryptionTransitions: false,
          currentShareUrl: `${window.location.origin}/secret#safe%20key`,
        }),
      ),
    );
    await waitFor(() => expect(harness.idbConstruct).toHaveBeenCalledWith("note:secret"));
  });

  it("disables encryption transitions in the embedded legacy-only workspace", async () => {
    harness.metaForSlug.mockResolvedValue({
      data: { is_encrypted: false },
      error: null,
    });
    render(
      <MemoryRouter>
        <NotePage legacyOnly embedSlug="secret" />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(harness.topbarProps).toHaveBeenLastCalledWith(
        expect.objectContaining({ allowEncryptionTransitions: false }),
      ),
    );
  });

  it.each(["owner", "edit"] as const)(
    "admits a matching polling capability session for %s scope",
    async (scope) => {
      const session = pollingSession({ scope });
      const access = { slug: "secret", scope, token: CAPABILITY_TOKEN };
      harness.capabilityOpenSession.mockResolvedValue(session);

      renderCapability(scope);

      await waitFor(() => expect(harness.capabilityProviderConstruct).toHaveBeenCalledTimes(1));
      expect(harness.capabilityOpenSession).toHaveBeenCalledWith(CAPABILITY_TOKEN);
      expect(harness.metaForSlug).not.toHaveBeenCalled();
      expect(harness.providerConstruct).not.toHaveBeenCalled();
      expect(harness.idbConstruct).not.toHaveBeenCalled();
      await waitFor(() => expect(harness.capabilityProviderConnect).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(harness.upsertPlaintextNote).toHaveBeenCalled());
      expect(
        harness.upsertPlaintextNote.mock.calls.every(
          (call) => (call[2] as { durable?: boolean } | undefined)?.durable === false,
        ),
      ).toBe(true);
      expect(harness.maybeSaveSnapshot).not.toHaveBeenCalled();
      expect(harness.recordOnSuddenDelete).not.toHaveBeenCalled();
      expect(harness.docAcquire).toHaveBeenCalledWith(
        `capability:${NOTE_ID}:${scope}:1`,
      );
      const capabilityDoc = harness.capabilityProviderConstruct.mock.calls[0]?.[2];
      expect(capabilityDoc).toEqual(
        expect.objectContaining({ getText: expect.any(Function) }),
      );
      expect(harness.capabilityProviderConstruct).toHaveBeenCalledWith(
        access,
        session,
        capabilityDoc,
        { pollingOnly: true },
      );
      await waitFor(() =>
        expect(harness.topbarProps).toHaveBeenLastCalledWith(
          expect.objectContaining({
            allowEncryptionTransitions: true,
            currentShareUrl: undefined,
            capabilityAccess: access,
            doc: capabilityDoc,
          }),
        ),
      );
    },
  );

  it.each([
    {
      name: "polling slug mismatch",
      scope: "owner" as const,
      session: pollingSession({ slug: "different" }),
    },
    {
      name: "polling scope mismatch",
      scope: "owner" as const,
      session: pollingSession({ scope: "edit" }),
    },
    {
      name: "matching private-Realtime session",
      scope: "owner" as const,
      session: privateRealtimeSession(),
    },
  ])("fails closed for $name", async ({ scope, session }) => {
    harness.capabilityOpenSession.mockResolvedValue(session);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const view = renderCapability(scope);

      await waitFor(() =>
        expect(warn).toHaveBeenCalledWith("Encryption metadata query failed"),
      );
      expect(harness.capabilityOpenSession).toHaveBeenCalledWith(CAPABILITY_TOKEN);
      expect(harness.metaForSlug).not.toHaveBeenCalled();
      expect(harness.docAcquire).not.toHaveBeenCalled();
      expect(harness.providerConstruct).not.toHaveBeenCalled();
      expect(harness.capabilityProviderConstruct).not.toHaveBeenCalled();
      expect(view.queryByTestId("editor")).not.toBeInTheDocument();
      expect(view.queryByTestId("preview")).not.toBeInTheDocument();
      expect(view.getByRole("alert")).toHaveTextContent("unlock.metadata_unavailable");
      expect(view.queryByText("unlock.metadata_conflict")).not.toBeInTheDocument();
      expect(view.queryByText("common.loading")).not.toBeInTheDocument();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not reuse an admitted session across same-slug capability navigation", async () => {
    const ownerSession = pollingSession();
    const rejectedEditSession = privateRealtimeSession({ scope: "edit" });
    let resolveEditSession!: (session: PrivateRealtimeNoteSession) => void;
    const pendingEditSession = new Promise<PrivateRealtimeNoteSession>((resolve) => {
      resolveEditSession = resolve;
    });
    harness.capabilityOpenSession.mockImplementation((token: string) => {
      if (token === CAPABILITY_TOKEN) return Promise.resolve(ownerSession);
      if (token === CAPABILITY_TOKEN_B) return pendingEditSession;
      throw new Error("unexpected capability token");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const view = renderCapabilityNavigation();
      await waitFor(() => expect(harness.capabilityProviderConstruct).toHaveBeenCalledTimes(1));
      expect(harness.docAcquire).toHaveBeenCalledTimes(1);

      fireEvent.click(view.getByRole("button", { name: "navigate-capability-b" }));

      await waitFor(() =>
        expect(harness.capabilityOpenSession).toHaveBeenCalledWith(CAPABILITY_TOKEN_B),
      );
      expect(harness.docAcquire).toHaveBeenCalledTimes(1);
      expect(harness.capabilityProviderConstruct).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveEditSession(rejectedEditSession);
        await pendingEditSession;
      });

      await waitFor(() =>
        expect(warn).toHaveBeenCalledWith("Encryption metadata query failed"),
      );
      expect(harness.docAcquire).toHaveBeenCalledTimes(1);
      expect(harness.capabilityProviderConstruct).toHaveBeenCalledTimes(1);
      expect(view.queryByTestId("editor")).not.toBeInTheDocument();
      expect(view.queryByTestId("preview")).not.toBeInTheDocument();
      expect(view.getByRole("alert")).toHaveTextContent("unlock.metadata_unavailable");
      expect(view.queryByText("unlock.metadata_conflict")).not.toBeInTheDocument();
      expect(view.queryByText("common.loading")).not.toBeInTheDocument();
    } finally {
      warn.mockRestore();
    }
  });

  it("separates the capability document cache from the same-slug legacy note", async () => {
    harness.capabilityOpenSession.mockResolvedValue(pollingSession());
    harness.metaForSlug.mockResolvedValue({ data: { is_encrypted: false }, error: null });
    const view = renderCapabilityNavigation();

    await waitFor(() =>
      expect(harness.docAcquire).toHaveBeenCalledWith(`capability:${NOTE_ID}:owner:1`),
    );
    fireEvent.click(view.getByRole("button", { name: "navigate-legacy" }));

    await waitFor(() =>
      expect(harness.docRelease).toHaveBeenCalledWith(`capability:${NOTE_ID}:owner:1`),
    );
    await waitFor(() => expect(harness.docAcquire).toHaveBeenCalledWith("secret"));
  });

  it("separates the same-slug legacy document cache from a capability note", async () => {
    harness.metaForSlug.mockResolvedValue({ data: { is_encrypted: false }, error: null });
    harness.capabilityOpenSession.mockResolvedValue(pollingSession());
    const view = renderCapabilityNavigation("/secret");

    await waitFor(() => expect(harness.docAcquire).toHaveBeenCalledWith("secret"));
    fireEvent.click(view.getByRole("button", { name: "navigate-owner" }));

    await waitFor(() => expect(harness.docRelease).toHaveBeenCalledWith("secret"));
    await waitFor(() =>
      expect(harness.docAcquire).toHaveBeenCalledWith(`capability:${NOTE_ID}:owner:1`),
    );
  });

  it("separates capability document caches across scope and generation", async () => {
    harness.capabilityOpenSession.mockImplementation((token: string) => {
      if (token === CAPABILITY_TOKEN) {
        return Promise.resolve(pollingSession({ scope: "owner", generation: 1 }));
      }
      if (token === CAPABILITY_TOKEN_B) {
        return Promise.resolve(pollingSession({ scope: "edit", generation: 2 }));
      }
      throw new Error("unexpected capability token");
    });
    const view = renderCapabilityNavigation();

    await waitFor(() =>
      expect(harness.docAcquire).toHaveBeenCalledWith(
        `capability:${NOTE_ID}:owner:1`,
      ),
    );
    fireEvent.click(view.getByRole("button", { name: "navigate-capability-b" }));

    await waitFor(() =>
      expect(harness.docRelease).toHaveBeenCalledWith(
        `capability:${NOTE_ID}:owner:1`,
      ),
    );
    await waitFor(() =>
      expect(harness.docAcquire).toHaveBeenCalledWith(
        `capability:${NOTE_ID}:edit:2`,
      ),
    );
  });

  it("fails closed when a previously encrypted note is reported as plaintext", async () => {
    expect(markNoteEncrypted("secret")).toBe(true);
    harness.metaForSlug.mockResolvedValue({
      data: { is_encrypted: false },
      error: null,
    });

    const view = renderStandalone();

    await waitFor(() =>
      expect(view.getByRole("alert")).toHaveTextContent("unlock.metadata_conflict"),
    );
    expect(view.queryByRole("button", { name: "common.retry" })).not.toBeInTheDocument();
    expect(harness.docAcquire).not.toHaveBeenCalled();
    expect(harness.providerConstruct).not.toHaveBeenCalled();
    expect(harness.providerConnect).not.toHaveBeenCalled();
    expect(harness.idbConstruct).not.toHaveBeenCalled();
    expect(harness.editorRender).not.toHaveBeenCalled();
    expect(harness.previewRender).not.toHaveBeenCalled();
  });

  it("fails closed when a previously encrypted note disappears from metadata", async () => {
    expect(markNoteEncrypted("secret")).toBe(true);
    harness.metaForSlug.mockResolvedValue({ data: null, error: null });

    const view = renderEmbedded();

    await waitFor(() =>
      expect(view.getByRole("alert")).toHaveTextContent("unlock.metadata_conflict"),
    );
    expect(view.queryByRole("button", { name: "common.retry" })).not.toBeInTheDocument();
    expect(harness.docAcquire).not.toHaveBeenCalled();
    expect(harness.providerConstruct).not.toHaveBeenCalled();
    expect(harness.providerConnect).not.toHaveBeenCalled();
    expect(harness.idbConstruct).not.toHaveBeenCalled();
    expect(harness.editorRender).not.toHaveBeenCalled();
    expect(harness.previewRender).not.toHaveBeenCalled();
  });

  it("fails closed when local encryption-pin storage is unavailable", async () => {
    const storageRead = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("storage denied", "SecurityError");
    });
    harness.metaForSlug.mockResolvedValue({
      data: { is_encrypted: false },
      error: null,
    });

    const view = renderEmbedded();

    await waitFor(() => expect(view.getByRole("alert")).toBeInTheDocument());
    expect(harness.docAcquire).not.toHaveBeenCalled();
    expect(harness.providerConstruct).not.toHaveBeenCalled();
    expect(harness.idbConstruct).not.toHaveBeenCalled();
    expect(harness.editorRender).not.toHaveBeenCalled();
    storageRead.mockRestore();
  });

  it("pins encrypted metadata before exposing the manual unlock gate", async () => {
    harness.metaForSlug.mockResolvedValue({
      data: {
        is_encrypted: true,
        enc_salt: "salt-secret",
        enc_check: "check-secret",
        enc_iterations: 1000,
        ydoc_state: "ciphertext-secret",
      },
      error: null,
    });

    const view = renderEmbedded();

    await waitFor(() =>
      expect(view.getByRole("dialog", { name: "Unlock encrypted note secret" })).toBeInTheDocument(),
    );
    expect(getEncryptionPinState("secret")).toBe("pinned");
    expect(harness.idbConstruct).not.toHaveBeenCalled();
    expect(harness.upsertPlaintextNote).not.toHaveBeenCalled();
  });

  it("still mounts a fresh unpinned plaintext note", async () => {
    harness.metaForSlug.mockResolvedValue({
      data: { is_encrypted: false },
      error: null,
    });

    const view = renderStandalone();

    await waitFor(() => expect(view.getByTestId("editor")).toBeInTheDocument());
    expect(harness.docAcquire).toHaveBeenCalledWith("secret");
    expect(harness.providerConstruct).toHaveBeenCalledWith("secret");
    expect(harness.idbConstruct).toHaveBeenCalledWith("note:secret");
    expect(harness.notesFrom).not.toHaveBeenCalled();
    await waitFor(() => expect(harness.upsertPlaintextNote).toHaveBeenCalled());
    expect(
      harness.upsertPlaintextNote.mock.calls.every(
        (call) => (call[2] as { durable?: boolean } | undefined)?.durable === true,
      ),
    ).toBe(true);
    expect(harness.capabilityOpenSession).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(harness.topbarProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          allowEncryptionTransitions: false,
          currentShareUrl: `${window.location.origin}/secret`,
          legacyOn: false,
          onLegacyEnable: expect.any(Function),
        }),
      ),
    );
  });

  it.each([
    ["existing LNO source", {
      data: {
        is_encrypted: false,
        content: "keep me",
        ydoc_state: "",
        enc_salt: null,
        enc_check: null,
        enc_iterations: null,
      },
      error: null,
    }],
    ["empty new note", { data: null, error: null }],
  ])("keeps %s on bare /slug through Edge upsert; Legacy ON converts", async (_label, meta) => {
    harness.metaForSlug.mockResolvedValue(meta);
    const owner = "c".repeat(43);
    harness.convertPlainNoteOnWrite.mockResolvedValue(`/secret#owner=${owner}`);
    harness.capabilityOpenSession.mockResolvedValue(pollingSession());

    function ConvertLocationProbe() {
      const loc = useLocation();
      return <div data-testid="loc">{`${loc.pathname}${loc.hash}`}</div>;
    }

    render(
      <MemoryRouter initialEntries={["/secret"]}>
        <Routes>
          <Route path="/:slug" element={<><ConvertLocationProbe /><NotePage /></>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(harness.upsertFn).toEqual(expect.any(Function)));
    expect(screen.getByTestId("loc")).toHaveTextContent("/secret");
    expect(screen.getByTestId("loc")).not.toHaveTextContent("#owner=");

    await act(async () => {
      await harness.upsertFn?.({
        slug: "secret",
        ydocState: "YQ",
        content: "typed",
        charCount: 5,
        tags: [],
        isEncrypted: false,
        salt: null,
        check: null,
        iterations: null,
      });
    });

    expect(harness.upsertPlainNote).toHaveBeenCalled();
    expect(harness.convertPlainNoteOnWrite).not.toHaveBeenCalled();
    expect(harness.toast).not.toHaveBeenCalledWith({ title: "security.legacy_secure_success_on" });
    expect(screen.getByTestId("loc")).toHaveTextContent("/secret");
    expect(screen.getByTestId("loc")).not.toHaveTextContent("#owner=");

    const enable = harness.topbarProps.mock.calls.at(-1)?.[0] as { onLegacyEnable?: () => void };
    await act(async () => {
      enable.onLegacyEnable?.();
    });

    await waitFor(() => {
      expect(harness.toast).toHaveBeenCalledWith({ title: "security.legacy_secure_success_on" });
    });
    expect(harness.convertPlainNoteOnWrite).toHaveBeenCalledOnce();
    expect(screen.getByTestId("loc")).toHaveTextContent(`/secret#owner=${owner}`);
    expect(harness.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "security.legacy_secure_fail_on" }),
    );
  });

  it("shows an honest reopen banner when persist learns the slug is capability-managed", async () => {
    harness.metaForSlug.mockResolvedValue({ data: null, error: null });

    function ConvertLocationProbe() {
      const loc = useLocation();
      return <div data-testid="loc">{`${loc.pathname}${loc.hash}`}</div>;
    }

    render(
      <MemoryRouter initialEntries={["/secret"]}>
        <Routes>
          <Route path="/" element={<div>home</div>} />
          <Route path="/:slug" element={<><ConvertLocationProbe /><NotePage /></>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(harness.onManaged).toEqual(expect.any(Function)));

    await act(async () => {
      harness.onManaged?.();
    });

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("security.legacy_secure_reopen_banner");
    });
    expect(screen.getByRole("button", { name: "security.legacy_secure_reopen_cta" })).toBeInTheDocument();
    expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
    expect(screen.getByTestId("loc")).toHaveTextContent("/secret");
    expect(screen.getByTestId("loc")).not.toHaveTextContent("#owner=");
    expect(harness.convertPlainNoteOnWrite).not.toHaveBeenCalled();
    expect(harness.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "security.legacy_secure_fail_on" }),
    );
    expect(harness.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "security.legacy_secure_success_on" }),
    );

    await act(async () => {
      screen.getByRole("button", { name: "security.legacy_secure_reopen_cta" }).click();
    });
    await waitFor(() => expect(screen.getByText("home")).toBeInTheDocument());
  });

  it("shows the reopen banner immediately for a managed LNO slug", async () => {
    harness.metaForSlug.mockResolvedValue({ managed: true });

    function ConvertLocationProbe() {
      const loc = useLocation();
      return <div data-testid="loc">{`${loc.pathname}${loc.hash}`}</div>;
    }

    render(
      <MemoryRouter initialEntries={["/secret"]}>
        <Routes>
          <Route path="/" element={<div>home</div>} />
          <Route path="/:slug" element={<><ConvertLocationProbe /><NotePage /></>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("security.legacy_secure_reopen_banner");
    });
    expect(harness.convertPlainNoteOnWrite).not.toHaveBeenCalled();
    expect(harness.providerConstruct).not.toHaveBeenCalled();
    expect(screen.getByTestId("loc")).toHaveTextContent("/secret");
    expect(screen.getByTestId("loc")).not.toHaveTextContent("#owner=");
    expect(harness.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "security.legacy_secure_success_on" }),
    );
  });

  it("shows the reopen banner for a pinned managed slug instead of the encryption metadata-conflict gate", async () => {
    expect(markNoteEncrypted("secret")).toBe(true);
    harness.metaForSlug.mockResolvedValue({ managed: true });

    render(
      <MemoryRouter initialEntries={["/secret"]}>
        <Routes>
          <Route path="/:slug" element={<NotePage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("security.legacy_secure_reopen_banner");
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(harness.convertPlainNoteOnWrite).not.toHaveBeenCalled();
  });

  it("immediately closes a live plaintext note when another local flow pins it", async () => {
    harness.metaForSlug.mockResolvedValue({
      data: { is_encrypted: false },
      error: null,
    });
    const view = renderStandalone();
    await waitFor(() => expect(view.getByTestId("editor")).toBeInTheDocument());

    act(() => {
      expect(markNoteEncrypted("secret")).toBe(true);
    });

    await waitFor(() => expect(view.getByRole("alert")).toBeInTheDocument());
    expect(view.queryByTestId("editor")).not.toBeInTheDocument();
    expect(view.queryByTestId("preview")).not.toBeInTheDocument();
    expect(harness.docRelease).toHaveBeenCalledWith("secret");
    expect(harness.providerDestroy).toHaveBeenCalledWith("secret");
  });

  it("immediately closes a live encrypted note when its local pin is cleared", async () => {
    harness.metaForSlug.mockResolvedValue({
      data: {
        is_encrypted: true,
        enc_salt: "salt-secret",
        enc_check: "check-secret",
        enc_iterations: 1000,
        ydoc_state: "ciphertext-secret",
      },
      error: null,
    });
    harness.deriveKey.mockResolvedValue({} as CryptoKey);
    harness.verifyCheck.mockResolvedValue(true);
    window.history.replaceState(null, "", "/secret#key");
    const view = renderStandalone();
    await waitFor(() => expect(view.getByTestId("editor")).toBeInTheDocument());

    act(() => {
      expect(clearNoteEncryptionPin("secret")).toBe(true);
    });

    await waitFor(() => expect(view.getByRole("alert")).toBeInTheDocument());
    expect(view.queryByTestId("editor")).not.toBeInTheDocument();
    expect(view.queryByTestId("preview")).not.toBeInTheDocument();
    expect(harness.docRelease).toHaveBeenCalledWith("secret");
    expect(harness.providerDestroy).toHaveBeenCalledWith("secret");
  });

  it("does not mount embedded editor or preview while encryption metadata is loading", () => {
    harness.metaPromise = new Promise(() => {});

    renderEmbedded();

    expect(harness.editorRender).not.toHaveBeenCalled();
    expect(harness.previewRender).not.toHaveBeenCalled();
    expect(harness.docAcquire).not.toHaveBeenCalled();
    expect(harness.providerConstruct).not.toHaveBeenCalled();
  });

  it("does not acquire document or provider resources for an abandoned render", () => {
    const never = new Promise<never>(() => {});
    const SuspendForever = (): never => {
      throw never;
    };

    const view = render(
      <MemoryRouter>
        <Suspense fallback={<div data-testid="abandoned-fallback" />}>
          <NotePage embedSlug="abandoned" />
          <SuspendForever />
        </Suspense>
      </MemoryRouter>,
    );

    expect(view.getByTestId("abandoned-fallback")).toBeInTheDocument();
    expect(harness.docAcquire).not.toHaveBeenCalled();
    expect(harness.providerConstruct).not.toHaveBeenCalled();
  });

  it("fails closed when the encryption metadata query returns an error", async () => {
    type FailedMetaResponse = { data: null; error: { message: string } };
    let resolveMeta!: (response: FailedMetaResponse) => void;
    const failedMeta = new Promise<FailedMetaResponse>((resolve) => {
      resolveMeta = resolve;
    });
    harness.metaForSlug.mockReturnValue(failedMeta);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const view = renderEmbedded();
      await waitFor(() => expect(harness.metaForSlug).toHaveBeenCalledWith("secret"));
      await act(async () => {
        resolveMeta({ data: null, error: { message: "metadata unavailable" } });
        await failedMeta;
      });

      await waitFor(() =>
        expect(view.getByRole("alert")).toHaveTextContent("unlock.metadata_unavailable"),
      );
      expect(view.getByText("unlock.metadata_unavailable_desc")).toBeInTheDocument();
      expect(view.getByRole("button", { name: "common.retry" })).toBeInTheDocument();
      expect(view.queryByText("unlock.metadata_conflict")).not.toBeInTheDocument();
      expect(view.queryByLabelText("Loading encryption metadata")).not.toBeInTheDocument();
      expect(view.queryByText("common.loading")).not.toBeInTheDocument();
      expect(warn).toHaveBeenCalledWith("Encryption metadata query failed");
      expect(harness.editorRender).not.toHaveBeenCalled();
      expect(harness.previewRender).not.toHaveBeenCalled();
      expect(harness.idbConstruct).not.toHaveBeenCalled();
      expect(harness.providerConnect).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("retries encryption metadata after a query throw and can recover", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    harness.metaForSlug.mockRejectedValue(new Error("network down"));

    try {
      const view = renderStandalone();

      await waitFor(() =>
        expect(view.getByRole("alert")).toHaveTextContent("unlock.metadata_unavailable"),
      );
      expect(view.getByRole("button", { name: "common.retry" })).toBeInTheDocument();
      expect(view.queryByLabelText("Loading encryption metadata")).not.toBeInTheDocument();
      expect(harness.editorRender).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("Encryption metadata query failed");

      let resolveRetry!: (value: { data: { is_encrypted: boolean }; error: null }) => void;
      const retryMeta = new Promise<{ data: { is_encrypted: boolean }; error: null }>((resolve) => {
        resolveRetry = resolve;
      });
      harness.metaForSlug.mockReset();
      harness.metaForSlug.mockReturnValue(retryMeta);

      fireEvent.click(view.getByRole("button", { name: "common.retry" }));

      await waitFor(() =>
        expect(view.getByLabelText("Loading encryption metadata")).toBeInTheDocument(),
      );
      expect(view.queryByRole("alert")).not.toBeInTheDocument();
      expect(harness.metaForSlug).toHaveBeenCalled();

      await act(async () => {
        resolveRetry({ data: { is_encrypted: false }, error: null });
        await retryMeta;
      });

      await waitFor(() => expect(view.getByTestId("editor")).toBeInTheDocument());
      expect(view.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      warn.mockRestore();
    }
  });

  it("closes the gate synchronously when an embedded note changes", async () => {
    const encryptedMetaPending = new Promise<{ data: Record<string, unknown> | null }>(() => {});
    harness.metaForSlug.mockImplementation((slug: string) => (
      slug === "plain"
        ? Promise.resolve({ data: { is_encrypted: false } })
        : encryptedMetaPending
    ));

    const { rerender } = render(
      <MemoryRouter>
        <NotePage embedSlug="plain" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(harness.editorRender).toHaveBeenCalled());
    await waitFor(() => expect(harness.providerConnect).toHaveBeenCalledWith("plain"));

    harness.editorRender.mockClear();
    harness.previewRender.mockClear();
    harness.idbConstruct.mockClear();
    harness.providerConnect.mockClear();

    rerender(
      <MemoryRouter>
        <NotePage embedSlug="encrypted" />
      </MemoryRouter>,
    );

    expect(harness.editorRender).not.toHaveBeenCalled();
    expect(harness.previewRender).not.toHaveBeenCalled();
    await waitFor(() => expect(harness.metaForSlug).toHaveBeenCalledWith("encrypted"));
    expect(harness.idbConstruct).not.toHaveBeenCalledWith("note:encrypted");
    expect(harness.providerConnect).not.toHaveBeenCalledWith("encrypted");
  });

  it("ignores auto-unlock crypto that finishes after the embedded target changes", async () => {
    let resolveAKey!: (key: CryptoKey) => void;
    const keyA = {} as CryptoKey;
    const deferredAKey = new Promise<CryptoKey>((resolve) => {
      resolveAKey = resolve;
    });
    harness.deriveKey.mockReturnValue(deferredAKey);
    harness.verifyCheck.mockResolvedValue(true);
    harness.metaForSlug.mockImplementation((slug: string) => Promise.resolve({
      data: {
        is_encrypted: true,
        enc_salt: `salt-${slug}`,
        enc_check: `check-${slug}`,
        enc_iterations: 1000,
        ydoc_state: `ciphertext-${slug}`,
      },
    }));
    window.history.replaceState(null, "", `${window.location.pathname}#key-a`);

    const view = render(
      <MemoryRouter>
        <NotePage embedSlug="a" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(harness.deriveKey).toHaveBeenCalledWith("key-a", "salt-a", 1));

    window.history.replaceState(null, "", window.location.pathname);
    view.rerender(
      <MemoryRouter>
        <NotePage embedSlug="b" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(view.getByRole("dialog", { name: "Unlock encrypted note b" })).toBeInTheDocument());
    harness.idbConstruct.mockClear();
    harness.providerConnect.mockClear();

    await act(async () => {
      resolveAKey(keyA);
      await deferredAKey;
      await Promise.resolve();
    });

    expect(view.getByRole("dialog", { name: "Unlock encrypted note b" })).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(harness.idbConstruct).not.toHaveBeenCalledWith("note:b");
    expect(harness.providerConnect).not.toHaveBeenCalledWith("b");
  });

  it("rejects pending auto-unlock when the live hash changes before Router commits", async () => {
    let resolveKey!: (key: CryptoKey) => void;
    const deferredKey = new Promise<CryptoKey>((resolve) => {
      resolveKey = resolve;
    });
    harness.metaForSlug.mockResolvedValue({
      data: {
        is_encrypted: true,
        enc_salt: "salt-secret",
        enc_check: "check-secret",
        enc_iterations: 1000,
        ydoc_state: "ciphertext-secret",
      },
    });
    harness.deriveKey.mockReturnValue(deferredKey);
    harness.verifyCheck.mockResolvedValue(true);
    window.history.replaceState(window.history.state, "", "/secret#old-key");

    const view = renderEmbedded();
    await waitFor(() =>
      expect(harness.deriveKey).toHaveBeenCalledWith("old-key", "salt-secret", 1),
    );

    // BrowserRouter updates the address bar synchronously, while its React
    // location update may still be queued in a transition. Model that window
    // without emitting a native hash event.
    window.history.replaceState(window.history.state, "", "/secret#new-key");
    await act(async () => {
      resolveKey({} as CryptoKey);
      await deferredKey;
      await Promise.resolve();
    });

    expect(view.queryByTestId("editor")).not.toBeInTheDocument();
    expect(view.queryByTestId("preview")).not.toBeInTheDocument();
    expect(harness.providerConnect).not.toHaveBeenCalled();
  });

  it.each([
    ["pathname", "/other-note"],
    ["search", "/secret?mode=next"],
  ])("rejects pending metadata when the live %s changes before Router commits", async (_part, target) => {
    let resolveMetadata!: (value: {
      data: { is_encrypted: boolean };
      error: null;
    }) => void;
    const pendingMetadata = new Promise<{
      data: { is_encrypted: boolean };
      error: null;
    }>((resolve) => {
      resolveMetadata = resolve;
    });
    harness.metaForSlug.mockReturnValue(pendingMetadata);
    window.history.replaceState(window.history.state, "", "/secret");

    const view = render(
      <BrowserRouter>
        <Routes>
          <Route path="/:slug" element={<NotePage legacyOnly />} />
        </Routes>
      </BrowserRouter>,
    );
    await waitFor(() => expect(harness.metaForSlug).toHaveBeenCalledWith("secret"));

    // BrowserRouter writes the live URL before its React location commits.
    // Keep the old route mounted and resolve its metadata inside that gap.
    window.history.pushState(window.history.state, "", target);
    await act(async () => {
      resolveMetadata({ data: { is_encrypted: false }, error: null });
      await pendingMetadata;
      await Promise.resolve();
    });

    expect(view.queryByTestId("editor")).not.toBeInTheDocument();
    expect(view.queryByTestId("preview")).not.toBeInTheDocument();
    expect(harness.providerConstruct).not.toHaveBeenCalled();
    expect(harness.providerConnect).not.toHaveBeenCalled();
  });

  it("falls back to the unlock gate for a malformed encrypted fragment", async () => {
    harness.metaForSlug.mockResolvedValue({
      data: {
        is_encrypted: true,
        enc_salt: "salt-secret",
        enc_check: "check-secret",
        enc_iterations: 1000,
        ydoc_state: "ciphertext-secret",
      },
    });
    window.history.replaceState(null, "", `${window.location.pathname}#%`);

    const view = renderEmbedded();

    await waitFor(() =>
      expect(
        view.getByRole("dialog", { name: "Unlock encrypted note secret" }),
      ).toBeInTheDocument(),
    );
    expect(harness.deriveKey).not.toHaveBeenCalled();
    expect(harness.editorRender).not.toHaveBeenCalled();
    expect(harness.previewRender).not.toHaveBeenCalled();
  });

  it("closes an unlocked note when React Router removes its key", async () => {
    harness.metaForSlug.mockResolvedValue({
      data: {
        is_encrypted: true,
        enc_salt: "salt-secret",
        enc_check: "check-secret",
        enc_iterations: 1000,
        ydoc_state: "ciphertext-secret",
      },
    });
    harness.deriveKey.mockResolvedValue({} as CryptoKey);
    harness.verifyCheck.mockResolvedValue(true);
    window.history.replaceState(null, "", "/secret#key");

    function BrowserNoteHarness() {
      const navigate = useNavigate();
      return (
        <>
          <button type="button" onClick={() => navigate("/secret")}>remove-note-key</button>
          <Routes>
            <Route path="/:slug" element={<NotePage />} />
          </Routes>
        </>
      );
    }

    const view = render(
      <BrowserRouter>
        <BrowserNoteHarness />
      </BrowserRouter>,
    );
    await waitFor(() => expect(view.getByTestId("editor")).toBeInTheDocument());

    fireEvent.click(view.getByRole("button", { name: "remove-note-key" }));

    expect(window.location.hash).toBe("");
    expect(view.queryByTestId("editor")).not.toBeInTheDocument();
    expect(view.queryByTestId("preview")).not.toBeInTheDocument();
    expect(view.getByLabelText("Loading encryption metadata")).toBeInTheDocument();

    // Let the replacement metadata request settle so the test cannot leak
    // post-assertion React updates into the next case.
    await waitFor(() =>
      expect(
        view.getByRole("dialog", { name: "Unlock encrypted note secret" }),
      ).toBeInTheDocument(),
    );
  });

  it("recreates a live provider and reacquires its document after relock and re-unlock", async () => {
    harness.metaForSlug.mockResolvedValue({
      data: {
        is_encrypted: true,
        enc_salt: "salt-secret",
        enc_check: "check-secret",
        enc_iterations: 1000,
        ydoc_state: "ciphertext-secret",
      },
    });
    harness.deriveKey.mockResolvedValue({} as CryptoKey);
    harness.verifyCheck.mockResolvedValue(true);
    window.history.replaceState(window.history.state, "", "/secret#first-key");

    const view = renderEmbedded();
    await waitFor(() => expect(view.getByTestId("editor")).toBeInTheDocument());
    await waitFor(() => expect(harness.providerConnect).toHaveBeenCalledTimes(1));
    expect(harness.idbConstruct).not.toHaveBeenCalled();
    await waitFor(() => expect(harness.upsertPlaintextNote).toHaveBeenCalled());
    expect(
      harness.upsertPlaintextNote.mock.calls.every(
        (call) => (call[2] as { durable?: boolean } | undefined)?.durable === false,
      ),
    ).toBe(true);
    const constructsBeforeRelock = harness.providerConstruct.mock.calls.length;
    const acquiresBeforeRelock = harness.docAcquire.mock.calls.length;
    const releasesBeforeRelock = harness.docRelease.mock.calls.length;

    act(() => {
      window.history.replaceState(window.history.state, "", "/secret");
      window.dispatchEvent(new Event("hashchange"));
    });
    await waitFor(() =>
      expect(
        view.getByRole("dialog", { name: "Unlock encrypted note secret" }),
      ).toBeInTheDocument(),
    );

    const unlock = harness.unlockProps.mock.lastCall?.[0].onUnlock as (
      key: CryptoKey,
    ) => void;
    act(() => {
      window.history.replaceState(window.history.state, "", "/secret#second-key");
      unlock({} as CryptoKey);
    });

    await waitFor(() => expect(view.getByTestId("editor")).toBeInTheDocument());
    await waitFor(() => expect(harness.providerConnect).toHaveBeenCalledTimes(2));
    expect(harness.providerConstruct).toHaveBeenCalledTimes(constructsBeforeRelock + 1);
    expect(harness.docAcquire).toHaveBeenCalledTimes(acquiresBeforeRelock + 1);
    expect(harness.docRelease).toHaveBeenCalledTimes(releasesBeforeRelock + 1);
  });

  it("relocks an encrypted sibling pane when another pane adopts a different hash key", async () => {
    type TestKey = CryptoKey & { submitted: string };
    harness.metaForSlug.mockImplementation((slug: string) => Promise.resolve({
      data: {
        is_encrypted: true,
        enc_salt: `salt-${slug}`,
        enc_check: `check-${slug}`,
        enc_iterations: 1000,
        ydoc_state: `ciphertext-${slug}`,
      },
    }));
    harness.deriveKey.mockImplementation(async (submitted: string) => ({
      submitted,
    }) as TestKey);
    harness.verifyCheck.mockImplementation(async (key: TestKey, check: string) => (
      key.submitted === "key-b" && check === "check-b"
    ));
    window.history.replaceState(window.history.state, "", "/split#key-b");

    const view = render(
      <MemoryRouter>
        <NotePage embedSlug="a" />
        <NotePage embedSlug="b" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(view.getAllByTestId("editor")).toHaveLength(1));
    await waitFor(() =>
      expect(
        view.getByRole("dialog", { name: "Unlock encrypted note a" }),
      ).toBeInTheDocument(),
    );
    const unlockA = harness.unlockProps.mock.calls.find(
      ([props]) => props.slug === "a",
    )?.[0].onUnlock as (key: CryptoKey) => void;

    act(() => {
      window.history.replaceState(window.history.state, "", "/split#key-a");
      unlockA({} as CryptoKey);
    });

    await waitFor(() => expect(view.getAllByTestId("editor")).toHaveLength(1));
    await waitFor(() =>
      expect(
        view.getByRole("dialog", { name: "Unlock encrypted note b" }),
      ).toBeInTheDocument(),
    );
  });

  it("ignores a manual unlock that finishes after the form target changes", async () => {
    const { UnlockForm: ActualUnlockForm } = await vi.importActual<
      typeof import("@/components/note/UnlockForm")
    >("@/components/note/UnlockForm");
    let resolveAKey!: (key: CryptoKey) => void;
    const keyA = {} as CryptoKey;
    const deferredAKey = new Promise<CryptoKey>((resolve) => {
      resolveAKey = resolve;
    });
    harness.deriveKey.mockReturnValue(deferredAKey);
    harness.verifyCheck.mockResolvedValue(true);
    const onUnlockA = vi.fn();
    const onUnlockB = vi.fn();
    window.history.replaceState(null, "", "/a");

    const view = render(
      <MemoryRouter>
        <ActualUnlockForm slug="a" salt="salt-a" check="check-a" iterations={1} onUnlock={onUnlockA} />
      </MemoryRouter>,
    );
    fireEvent.change(view.getByPlaceholderText("unlock.placeholder"), { target: { value: "pass-a" } });
    fireEvent.submit(view.container.querySelector("form")!);
    await waitFor(() => expect(harness.deriveKey).toHaveBeenCalledWith("pass-a", "salt-a", 1));

    window.history.replaceState(null, "", "/b");
    view.rerender(
      <MemoryRouter>
        <ActualUnlockForm slug="b" salt="salt-b" check="check-b" iterations={1} onUnlock={onUnlockB} />
      </MemoryRouter>,
    );
    await act(async () => {
      resolveAKey(keyA);
      await deferredAKey;
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe("/b");
    expect(window.location.hash).toBe("");
    expect(onUnlockA).not.toHaveBeenCalled();
    expect(onUnlockB).not.toHaveBeenCalled();
  });

  it("ignores a manual unlock when only the live URL target changes", async () => {
    const { UnlockForm: ActualUnlockForm } = await vi.importActual<
      typeof import("@/components/note/UnlockForm")
    >("@/components/note/UnlockForm");
    let resolveKey!: (key: CryptoKey) => void;
    const deferredKey = new Promise<CryptoKey>((resolve) => {
      resolveKey = resolve;
    });
    const key = {} as CryptoKey;
    harness.deriveKey.mockReturnValue(deferredKey);
    harness.verifyCheck.mockResolvedValue(true);
    const onUnlockA = vi.fn();
    const onUnlockB = vi.fn();
    window.history.replaceState(null, "", `/s/${SHARE_TOKEN_A}`);

    const view = render(
      <MemoryRouter>
        <ActualUnlockForm slug="shared" salt="same-salt" check="same-check" iterations={1} onUnlock={onUnlockA} />
      </MemoryRouter>,
    );
    fireEvent.change(view.getByPlaceholderText("unlock.placeholder"), {
      target: { value: "pass-a" },
    });
    fireEvent.submit(view.container.querySelector("form")!);
    await waitFor(() =>
      expect(harness.deriveKey).toHaveBeenCalledWith("pass-a", "same-salt", 1),
    );

    window.history.replaceState(null, "", `/s/${SHARE_TOKEN_B}`);
    view.rerender(
      <MemoryRouter>
        <ActualUnlockForm slug="shared" salt="same-salt" check="same-check" iterations={1} onUnlock={onUnlockB} />
      </MemoryRouter>,
    );
    await act(async () => {
      resolveKey(key);
      await deferredKey;
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe(`/s/${SHARE_TOKEN_B}`);
    expect(window.location.hash).toBe("");
    expect(onUnlockA).not.toHaveBeenCalled();
    expect(onUnlockB).not.toHaveBeenCalled();
  });

  it("ignores a manual unlock when only the live URL hash changes", async () => {
    const { UnlockForm: ActualUnlockForm } = await vi.importActual<
      typeof import("@/components/note/UnlockForm")
    >("@/components/note/UnlockForm");
    let resolveKey!: (key: CryptoKey) => void;
    const deferredKey = new Promise<CryptoKey>((resolve) => {
      resolveKey = resolve;
    });
    const key = {} as CryptoKey;
    harness.deriveKey.mockReturnValue(deferredKey);
    harness.verifyCheck.mockResolvedValue(true);
    const onUnlock = vi.fn();
    window.history.replaceState(null, "", "/same-note#starting-key");

    const view = render(
      <MemoryRouter>
        <ActualUnlockForm
          slug="same-note"
          salt="same-salt"
          check="same-check"
          iterations={1}
          onUnlock={onUnlock}
        />
      </MemoryRouter>,
    );
    fireEvent.change(view.getByPlaceholderText("unlock.placeholder"), {
      target: { value: "submitted-key" },
    });
    fireEvent.submit(view.container.querySelector("form")!);
    await waitFor(() =>
      expect(harness.deriveKey).toHaveBeenCalledWith("submitted-key", "same-salt", 1),
    );

    window.history.replaceState(null, "", "/same-note#newer-key");
    await act(async () => {
      resolveKey(key);
      await deferredKey;
      await Promise.resolve();
    });

    expect(window.location.hash).toBe("#newer-key");
    expect(onUnlock).not.toHaveBeenCalled();
  });

  it("preserves the query string when a manual unlock writes its hash", async () => {
    const { UnlockForm: ActualUnlockForm } = await vi.importActual<
      typeof import("@/components/note/UnlockForm")
    >("@/components/note/UnlockForm");
    const key = {} as CryptoKey;
    harness.deriveKey.mockResolvedValue(key);
    harness.verifyCheck.mockResolvedValue(true);
    const onUnlock = vi.fn();
    window.history.replaceState(null, "", "/same-note?mode=share");

    const view = render(
      <MemoryRouter>
        <ActualUnlockForm
          slug="same-note"
          salt="same-salt"
          check="same-check"
          iterations={1}
          onUnlock={onUnlock}
        />
      </MemoryRouter>,
    );
    fireEvent.change(view.getByPlaceholderText("unlock.placeholder"), {
      target: { value: "submitted-key" },
    });
    fireEvent.submit(view.container.querySelector("form")!);

    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith(key));
    expect(window.location.pathname).toBe("/same-note");
    expect(window.location.search).toBe("?mode=share");
    expect(window.location.hash).toBe("#submitted-key");
  });

  it("preserves React Router history state when a manual unlock writes its hash", async () => {
    const { UnlockForm: ActualUnlockForm } = await vi.importActual<
      typeof import("@/components/note/UnlockForm")
    >("@/components/note/UnlockForm");
    const key = {} as CryptoKey;
    harness.deriveKey.mockResolvedValue(key);
    harness.verifyCheck.mockResolvedValue(true);
    const onUnlock = vi.fn();
    const routerState = {
      idx: 7,
      key: "router-entry",
      usr: { source: "split" },
    };
    window.history.replaceState(routerState, "", "/same-note?mode=share");

    const view = render(
      <MemoryRouter>
        <ActualUnlockForm
          slug="same-note"
          salt="same-salt"
          check="same-check"
          iterations={1}
          onUnlock={onUnlock}
        />
      </MemoryRouter>,
    );
    fireEvent.change(view.getByPlaceholderText("unlock.placeholder"), {
      target: { value: "submitted-key" },
    });
    fireEvent.submit(view.container.querySelector("form")!);

    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith(key));
    expect(window.history.state).toEqual(routerState);
  });

  it("cancels a busy manual unlock on query-only history navigation", async () => {
    const { UnlockForm: ActualUnlockForm } = await vi.importActual<
      typeof import("@/components/note/UnlockForm")
    >("@/components/note/UnlockForm");
    let resolveKey!: (key: CryptoKey) => void;
    const deferredKey = new Promise<CryptoKey>((resolve) => {
      resolveKey = resolve;
    });
    harness.deriveKey.mockReturnValue(deferredKey);
    harness.verifyCheck.mockResolvedValue(true);
    const onUnlock = vi.fn();
    window.history.replaceState(null, "", "/same-note?mode=a");

    function QueryNavigationHarness() {
      const navigate = useNavigate();
      return (
        <>
          <button type="button" onClick={() => navigate("?mode=b")}>navigate-query</button>
          <ActualUnlockForm
            slug="same-note"
            salt="same-salt"
            check="same-check"
            iterations={1}
            onUnlock={onUnlock}
          />
        </>
      );
    }

    const view = render(
      <MemoryRouter
        initialEntries={["/same-note?mode=a"]}
      >
        <QueryNavigationHarness />
      </MemoryRouter>,
    );
    fireEvent.change(view.getByPlaceholderText("unlock.placeholder"), {
      target: { value: "submitted-key" },
    });
    fireEvent.submit(view.container.querySelector("form")!);
    await waitFor(() =>
      expect(view.getByLabelText("Loading encryption metadata")).toBeInTheDocument(),
    );

    fireEvent.click(view.getByRole("button", { name: "navigate-query" }));

    expect(view.queryByLabelText("Loading encryption metadata")).not.toBeInTheDocument();
    expect(view.getByPlaceholderText("unlock.placeholder")).toHaveValue("");

    await act(async () => {
      resolveKey({} as CryptoKey);
      await deferredKey;
    });

    expect(onUnlock).not.toHaveBeenCalled();
    expect(view.queryByLabelText("Loading encryption metadata")).not.toBeInTheDocument();
  });

  it("restarts auto-unlock and rejects the old key after a hash-only change", async () => {
    let resolveFirstKey!: (key: CryptoKey) => void;
    const firstKey = {} as CryptoKey;
    const deferredFirstKey = new Promise<CryptoKey>((resolve) => {
      resolveFirstKey = resolve;
    });
    const neverResolve = new Promise<CryptoKey>(() => {});
    harness.deriveKey.mockImplementation((passphrase: string) =>
      passphrase === "key-one" ? deferredFirstKey : neverResolve,
    );
    harness.verifyCheck.mockResolvedValue(true);
    harness.decryptBytes.mockResolvedValue(Y.encodeStateAsUpdate(new Y.Doc()));
    harness.shareInvoke.mockResolvedValue(encryptedShareResponse("auto"));
    window.history.replaceState(null, "", `/s/${SHARE_TOKEN_A}#key-one`);

    renderShareRoute();
    await waitFor(() =>
      expect(harness.deriveKey).toHaveBeenCalledWith("key-one", "salt-auto", 1),
    );

    act(() => {
      window.history.replaceState(null, "", `/s/${SHARE_TOKEN_A}#key-two`);
      window.dispatchEvent(new Event("hashchange"));
    });
    await waitFor(() =>
      expect(harness.deriveKey).toHaveBeenCalledWith("key-two", "salt-auto", 1),
    );

    await act(async () => {
      resolveFirstKey(firstKey);
      await deferredFirstKey;
      await Promise.resolve();
    });

    expect(harness.previewRender).not.toHaveBeenCalled();
  });

  it("observes same-token hash navigation performed by React Router", async () => {
    harness.shareInvoke.mockResolvedValue(encryptedShareResponse("router"));
    harness.deriveKey.mockReturnValue(new Promise<CryptoKey>(() => {}));
    window.history.replaceState(null, "", `/s/${SHARE_TOKEN_A}`);

    const view = renderShareRoute();
    await waitFor(() => expect(harness.unlockProps).toHaveBeenCalledTimes(1));

    fireEvent.click(view.getByRole("button", { name: "navigate-share-hash" }));

    await waitFor(() =>
      expect(harness.deriveKey).toHaveBeenCalledWith("router-key", "salt-router", 1),
    );
    expect(view.getByTestId("skeleton")).toBeInTheDocument();
    expect(harness.previewRender).not.toHaveBeenCalled();
  });

  it("rejects a manual share decrypt after its hash target changes", async () => {
    let resolveDecrypt!: (value: Uint8Array) => void;
    const deferredDecrypt = new Promise<Uint8Array>((resolve) => {
      resolveDecrypt = resolve;
    });
    harness.decryptBytes.mockReturnValue(deferredDecrypt);
    harness.deriveKey.mockReturnValue(new Promise<CryptoKey>(() => {}));
    harness.shareInvoke.mockResolvedValue(encryptedShareResponse("manual"));
    window.history.replaceState(null, "", `/s/${SHARE_TOKEN_A}`);

    renderShareRoute();
    await waitFor(() => expect(harness.unlockProps).toHaveBeenCalledTimes(1));
    const staleUnlock = harness.unlockProps.mock.calls[0][0].onUnlock;

    window.history.replaceState(null, "", `/s/${SHARE_TOKEN_A}#submitted-key`);
    void staleUnlock({} as CryptoKey);
    await waitFor(() => expect(harness.decryptBytes).toHaveBeenCalled());

    act(() => {
      window.history.replaceState(null, "", `/s/${SHARE_TOKEN_A}#newer-key`);
      window.dispatchEvent(new Event("hashchange"));
    });
    await waitFor(() =>
      expect(harness.deriveKey).toHaveBeenCalledWith("newer-key", "salt-manual", 1),
    );

    await act(async () => {
      resolveDecrypt(Y.encodeStateAsUpdate(new Y.Doc()));
      await deferredDecrypt;
      await Promise.resolve();
    });

    expect(harness.previewRender).not.toHaveBeenCalled();
  });

  it("keeps a successful manual share unlock without refetching", async () => {
    harness.shareInvoke
      .mockResolvedValueOnce(encryptedShareResponse("manual-success"))
      .mockReturnValue(new Promise(() => {}));
    harness.decryptBytes.mockResolvedValue(Y.encodeStateAsUpdate(new Y.Doc()));
    window.history.replaceState(null, "", `/s/${SHARE_TOKEN_A}`);

    const view = renderShareRoute();
    await waitFor(() => expect(harness.unlockProps).toHaveBeenCalledTimes(1));
    const onUnlock = harness.unlockProps.mock.lastCall?.[0].onUnlock as (
      key: CryptoKey,
    ) => Promise<void>;

    window.history.replaceState(
      null,
      "",
      `/s/${SHARE_TOKEN_A}#submitted-key`,
    );
    await act(async () => {
      await onUnlock({} as CryptoKey);
    });

    expect(harness.shareInvoke).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("preview")).toBeInTheDocument();
    expect(view.queryByTestId("skeleton")).not.toBeInTheDocument();

    harness.translate = (key: string) => `next:${key}`;
    view.rerender(
      <MemoryRouter
        initialEntries={[`/s/${SHARE_TOKEN_A}`]}
      >
        <ShareRouteHarness />
      </MemoryRouter>,
    );
    expect(harness.shareInvoke).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("preview")).toBeInTheDocument();

    act(() => {
      window.history.replaceState(null, "", `/s/${SHARE_TOKEN_A}`);
      window.dispatchEvent(new Event("hashchange"));
    });

    expect(view.queryByTestId("preview")).not.toBeInTheDocument();
    expect(view.getByTestId("skeleton")).toBeInTheDocument();
    await waitFor(() => expect(harness.shareInvoke).toHaveBeenCalledTimes(2));
  });

  it("does not let an old locked state adopt a newer same-token generation", async () => {
    harness.decryptBytes.mockResolvedValue(Y.encodeStateAsUpdate(new Y.Doc()));
    harness.shareInvoke.mockResolvedValue(encryptedShareResponse("generation"));
    window.history.replaceState(null, "", `/s/${SHARE_TOKEN_A}`);

    const view = renderShareRoute();
    await waitFor(() => expect(harness.unlockProps).toHaveBeenCalledTimes(1));
    const staleUnlock = harness.unlockProps.mock.calls[0][0].onUnlock;

    act(() => {
      window.history.replaceState(
        null,
        "",
        `/s/${SHARE_TOKEN_A}#next-generation`,
      );
      window.dispatchEvent(new Event("hashchange"));
    });
    await waitFor(() => expect(harness.shareInvoke).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(harness.unlockProps.mock.calls.length).toBeGreaterThanOrEqual(2));
    harness.previewRender.mockClear();

    await act(async () => {
      await staleUnlock({} as CryptoKey);
    });

    expect(harness.previewRender).not.toHaveBeenCalled();
    expect(view.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps a resolved share B locked when share A decrypt finishes late", async () => {
    let resolveDecrypt!: (value: Uint8Array) => void;
    const deferredDecrypt = new Promise<Uint8Array>((resolve) => {
      resolveDecrypt = resolve;
    });
    harness.decryptBytes.mockReturnValue(deferredDecrypt);
    harness.shareInvoke.mockImplementation(
      (_name: string, options: { headers: { "x-legacy-share": string } }) => {
        const shareToken = options.headers["x-legacy-share"];
        return Promise.resolve({
          data: {
            content: "",
            ydoc_state: "ciphertext",
            is_encrypted: true,
            enc_salt: `salt-${shareToken}`,
            enc_check: `check-${shareToken}`,
            enc_iterations: 1,
            updated_at: "2026-07-19T00:00:00.000Z",
          },
          error: null,
        });
      },
    );

    const view = renderShareRoute();
    await waitFor(() =>
      expect(harness.unlockProps).toHaveBeenCalledWith(
        expect.objectContaining({ salt: `salt-${SHARE_TOKEN_A}` }),
      ),
    );
    const onUnlockA = harness.unlockProps.mock.lastCall?.[0].onUnlock as (
      key: CryptoKey,
    ) => Promise<void>;
    const pendingUnlock = onUnlockA({} as CryptoKey);
    await waitFor(() => expect(harness.decryptBytes).toHaveBeenCalled());

    fireEvent.click(view.getByRole("button", { name: "navigate-share-b" }));
    await waitFor(() =>
      expect(harness.unlockProps.mock.lastCall?.[0]).toEqual(
        expect.objectContaining({ salt: `salt-${SHARE_TOKEN_B}` }),
      ),
    );

    await act(async () => {
      resolveDecrypt(new Uint8Array([1]));
      await deferredDecrypt;
      await pendingUnlock;
    });

    expect(harness.unlockProps.mock.lastCall?.[0]).toEqual(
      expect.objectContaining({ salt: `salt-${SHARE_TOKEN_B}` }),
    );
    expect(harness.previewRender).not.toHaveBeenCalled();
  });

  it.each([
    ["embedded", renderEmbedded],
    ["standalone", renderStandalone],
  ])("shows the unlock gate without mounting %s editor or preview", async (_mode, renderPage) => {
    harness.metaPromise = Promise.resolve({
      data: {
        is_encrypted: true,
        enc_salt: "salt",
        enc_check: "check",
        enc_iterations: 1000,
        ydoc_state: "ciphertext",
      },
    });

    renderPage();
    await waitFor(() => expect(harness.unlockRender).toHaveBeenCalled());

    expect(harness.editorRender).not.toHaveBeenCalled();
    expect(harness.previewRender).not.toHaveBeenCalled();
  });
});
