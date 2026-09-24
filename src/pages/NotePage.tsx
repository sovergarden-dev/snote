import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Helmet } from "react-helmet-async";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { Editor, type EditorHandle } from "@/components/note/Editor";
import { Preview } from "@/components/note/Preview";
import { Topbar } from "@/components/note/Topbar";
import { UnlockForm } from "@/components/note/UnlockForm";
import { PageIndicator } from "@/components/note/PageIndicator";
import { GoalConfetti } from "@/components/note/GoalConfetti";

import { useWordGoal, consumeGoalReached } from "@/hooks/use-word-goal";
import { toast } from "@/hooks/use-toast";
import { OutlineSidebar } from "@/components/note/OutlineSidebar";
import { SupabaseYjsProvider, type Encryption, type YjsProviderLike } from "@/lib/yjs/provider";
import type { NoteSession } from "@/lib/capability/client";
import { parseCapabilityLocation, readEncryptionSecret, type CapabilityAccess } from "@/lib/capability/url";
import { getIdentity } from "@/lib/yjs/identity";
import { touchRecent } from "@/lib/recent-notes";
import { hydrateNoteIndex, rememberMetadata, upsertPlaintextNote } from "@/lib/note-index";
import { applyTemplateSeedIfEmpty } from "@/lib/note-templates";
import type { PresenceUser } from "@/components/note/PresenceDots";
import { maybeSaveSnapshot, recordOnSuddenDelete } from "@/lib/snapshots";
import { useZenMode } from "@/hooks/use-zen-mode";
import { useTypewriterMode } from "@/hooks/use-typewriter-mode";
import { usePreviewVisible } from "@/hooks/use-preview-visible";
import { useNarrowViewport } from "@/hooks/use-narrow-viewport";
import { useScrollSyncEnabled } from "@/hooks/use-scroll-sync-enabled";
import { useScrollSync } from "@/hooks/use-scroll-sync";
import { useFocusLine } from "@/hooks/use-focus-line";
import { WIKI_NAV_EVENT } from "@/lib/wiki-link";
import { useEink } from "@/hooks/use-eink";
import { useVimMode } from "@/hooks/use-vim-mode";
import { usePagination } from "@/hooks/use-pagination";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/i18n";
import { deriveKey, encryptBytes, decryptBytes, verifyCheck, iterationsFor } from "@/lib/crypto";
import { acquireDoc, releaseDoc } from "@/lib/yjs/doc-cache";
import { getNoteHost, noteHostKey, type NoteHostGate } from "@/lib/yjs/note-host";
import { useNoteHost } from "@/hooks/use-note-host";
import type { LegacyNote } from "@/lib/legacy/cutover";
import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { isExtensionContext } from "@/lib/ext-context";
import {
  ENCRYPTION_PIN_CHANGE_EVENT,
  encryptionPinStorageKey,
  getEncryptionPinState,
  markNoteEncrypted,
  clearNoteEncryptionPin,
} from "@/lib/encryption-pin";
import {
  LEGACY_SECURE_PIN_CHANGE_EVENT,
  clearLegacySecurePin,
  clearPlainNoteIndexedDb,
  hasLegacySecurePin,
  legacySecurePinKey,
  markLegacySecurePin,
} from "@/lib/legacy/legacy-secure-pin";

const SLUG_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const SUDDEN_DELETE_THRESHOLD = 500;
const SUDDEN_DELETE_WINDOW_MS = 2000;
const COUNT_DEBOUNCE_MS = 150;

interface NotePageProps {
  /** Ignore capability-shaped fragments while the capability backend is offline. */
  legacyOnly?: boolean;
  /** When provided (e.g. from SplitView), use this slug instead of the route param. */
  embedSlug?: string;
  /** Container-derived layout mode for an embedded split pane. */
  embedNarrow?: boolean;
  /** Reports the pane's active scroll element after lazy/encryption gates open. */
  onPrimaryScroller?: (element: HTMLElement | null) => void;
}

type EncMeta = {
  isEncrypted: boolean;
  salt: string | null;
  check: string | null;
  iterations: number | null;
  ydocState: string | null;
  rowExists: boolean;
};

type EncGateTarget = {
  slug: string;
  metaVersion: number;
};

type NoteResources = EncGateTarget & {
  providerEpoch: number;
  doc: Y.Doc;
  provider: YjsProviderLike;
};

type CapabilityAdmission = {
  access: CapabilityAccess;
  session: NoteSession;
  YjsProvider: CapabilityYjsProviderCtor;
};

type CapabilityYjsProviderCtor = typeof import("@/lib/yjs/capability-provider").CapabilityYjsProvider;

type CapabilityRuntime = {
  createCapabilityApi: (typeof import("@/lib/capability/client"))["createCapabilityApi"];
  CapabilityYjsProvider: CapabilityYjsProviderCtor;
};

type PlainRuntime = {
  createLegacyNoteApi: (typeof import("@/lib/legacy/cutover"))["createLegacyNoteApi"];
  mapDuplicateFailure: (typeof import("@/lib/legacy/cutover"))["mapDuplicateFailure"];
  convertPlainNoteOnWrite: (typeof import("@/lib/legacy/convert-on-write"))["convertPlainNoteOnWrite"];
  consumeConvertSeed: (typeof import("@/lib/legacy/convert-on-write"))["consumeConvertSeed"];
  CapabilityManagedError: (typeof import("@/lib/legacy/cutover"))["CapabilityManagedError"];
  PlainUpsertProvider: typeof import("@/lib/yjs/plain-upsert-provider").PlainUpsertProvider;
};

let capabilityRuntime: CapabilityRuntime | undefined;
let capabilityRuntimePromise: Promise<CapabilityRuntime> | undefined;
let plainRuntime: PlainRuntime | undefined;
let plainRuntimePromise: Promise<PlainRuntime> | undefined;

const loadCapabilityRuntime = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true"
  ? () => {
      capabilityRuntimePromise ??= Promise.all([
        import("@/lib/capability/client"),
        import("@/lib/yjs/capability-provider"),
      ]).then(([client, provider]) => {
        const runtime: CapabilityRuntime = {
          createCapabilityApi: client.createCapabilityApi,
          CapabilityYjsProvider: provider.CapabilityYjsProvider,
        };
        capabilityRuntime = runtime;
        return runtime;
      });
      return capabilityRuntimePromise;
    }
  : async (): Promise<CapabilityRuntime> => {
      throw new Error("capability API unavailable");
    };

const loadPlainRuntime = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true"
  ? () => {
      plainRuntimePromise ??= Promise.all([
        import("@/lib/legacy/cutover"),
        import("@/lib/legacy/convert-on-write"),
        import("@/lib/yjs/plain-upsert-provider"),
      ]).then(([cutover, convert, local]) => {
        const runtime: PlainRuntime = {
          createLegacyNoteApi: cutover.createLegacyNoteApi,
          mapDuplicateFailure: cutover.mapDuplicateFailure,
          convertPlainNoteOnWrite: convert.convertPlainNoteOnWrite,
          consumeConvertSeed: convert.consumeConvertSeed,
          CapabilityManagedError: cutover.CapabilityManagedError,
          PlainUpsertProvider: local.PlainUpsertProvider,
        };
        plainRuntime = runtime;
        return runtime;
      });
      return plainRuntimePromise;
    }
  : async (): Promise<PlainRuntime> => {
      throw new Error("plain convert runtime unavailable");
    };

const LazyCutoverNotePage = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true"
  ? lazy(() => import("./CutoverNotePage"))
  : null;

export function CutoverNotePage(props: NotePageProps) {
  if (!LazyCutoverNotePage) return null;
  return (
    <Suspense fallback={null}>
      <LazyCutoverNotePage {...props} />
    </Suspense>
  );
}

export default function NotePage({
  legacyOnly = false,
  embedSlug,
  embedNarrow,
  onPrimaryScroller,
}: NotePageProps) {
  const params = useParams();
  const location = useLocation();
  const slug = embedSlug ?? params.slug ?? "";
  const validSlug = SLUG_RE.test(slug);
  const capabilityAccess: CapabilityAccess | null = useMemo(() => {
    if (legacyOnly) return null;
    const parsed = typeof window === "undefined"
      ? null
      : parseCapabilityLocation(new URL(
        `${location.pathname}${location.search}${location.hash}`,
        window.location.origin,
      ));
    return parsed && parsed.scope !== "view" && parsed.slug === slug ? parsed : null;
  }, [legacyOnly, slug, location.pathname, location.search, location.hash]);
  const capabilityToken = capabilityAccess?.token ?? null;
  const hostKey = validSlug ? noteHostKey({ slug, capabilityToken }) : null;
  const { gate } = useNoteHost(hostKey);
  const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches;
  const { visible: showPreview, setVisible: setShowPreview } = usePreviewVisible();
  // On narrow viewports (< 900 px) the editor + preview are NOT shown
  // side-by-side. Instead, the preview toggle swaps the visible pane between
  // editor and rendered markdown. `showPreview` keeps the same semantic
  // meaning ("user wants to see the preview") and is the only piece of state
  // we need — layout logic below derives both modes from it.
  const viewportNarrow = useNarrowViewport();
  const narrow = embedNarrow ?? viewportNarrow;
  const showEditorPane = !narrow || !showPreview;
  const showPreviewPane = showPreview;
  const { enabled: scrollSync, toggle: toggleScrollSync } = useScrollSyncEnabled();
  const [editorScrollEl, setEditorScrollEl] = useState<HTMLElement | null>(null);
  const [previewScrollEl, setPreviewScrollEl] = useState<HTMLElement | null>(null);
  // Scroll sync only makes sense when BOTH panes are visible at the same
  // time. On narrow viewports only one pane is rendered, so disable.
  useScrollSync(editorScrollEl, previewScrollEl, scrollSync && showPreview && !narrow);
  useEffect(() => {
    if (!embedSlug || !onPrimaryScroller) return;
    const primaryScroller = showEditorPane ? editorScrollEl : previewScrollEl;
    onPrimaryScroller(primaryScroller);
    return () => onPrimaryScroller(null);
  }, [
    embedSlug,
    editorScrollEl,
    onPrimaryScroller,
    previewScrollEl,
    showEditorPane,
  ]);
  const [users, setUsers] = useState<PresenceUser[]>([]);
  const [counts, setCounts] = useState({ chars: 0, words: 0 });
  const { goal } = useWordGoal(slug);
  const { t } = useI18n();
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);

  // Provider generations are invalidated when the persisted encryption mode
  // changes. Resource construction itself happens after commit below so an
  // abandoned concurrent render cannot pin a document or leak a provider.
  const providerEpoch = gate.providerEpoch;

  // Celebrate when crossing the goal threshold (once per goal value).
  // `confettiTrigger` bumps in lockstep with the toast so a CSS-only burst
  // fires alongside the notification (U6).
  const [confettiTrigger, setConfettiTrigger] = useState(0);
  useEffect(() => {
    if (consumeGoalReached(slug, counts.words, goal)) {
      toast({
        title: t("note.goal_reached"),
        description: `${counts.words.toLocaleString()} / ${goal!.toLocaleString()}`,
      });
      setConfettiTrigger((n) => n + 1);
    }
  }, [slug, counts.words, goal, t]);

  const editorRef = useRef<EditorHandle>(null);
  const outlineTriggerRef = useRef<HTMLButtonElement>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const { zen, toggle: toggleZen } = useZenMode();
  const { typewriter, toggle: toggleTypewriter } = useTypewriterMode();
  const { vim } = useVimMode();
  const { focusLine, toggle: toggleFocusLine } = useFocusLine();
  const navigate = useNavigate();

  // Ctrl/Cmd+Click on a `[[slug]]` token in the editor dispatches this event.
  // Skip in embed (SplitView) mode — otherwise both panels would navigate and
  // push duplicate history entries.
  useEffect(() => {
    if (embedSlug) return;
    const onNav = (e: Event) => {
      const target = (e as CustomEvent<{ slug: string }>).detail?.slug;
      if (target) navigate("/" + target);
    };
    window.addEventListener(WIKI_NAV_EVENT, onNav);
    return () => window.removeEventListener(WIKI_NAV_EVENT, onNav);
  }, [navigate, embedSlug]);

  // Per-note head tags rendered via react-helmet-async below (in JSX).
  const { enabled: paginated, toggle: togglePagination, flip, page, totalPages } = usePagination();
  useEink();

  // Encryption phases: "loading" (waiting on enc-meta), "needs-key", "blocked",
  // "error" (enc-meta fetch failed; retryable), "ready". A blocked note has
  // violated the durable encrypted-state pin and must never mount
  // local/network persistence as plaintext.
  // Editor/Preview and network sync stay unmounted until the gate is ready.
  const encPhase = gate.encPhase;
  const encMeta = gate.encMeta;
  const encryption = (gate.encryption ?? null) as Encryption | null;
  const capabilityAdmission = (gate.capabilityAdmission ?? null) as CapabilityAdmission | null;
  const admittedCapability = capabilityAccess
    && capabilityAdmission
    && capabilityAdmission.access.token === capabilityAccess.token
    && capabilityAdmission.access.scope === capabilityAccess.scope
    && capabilityAdmission.access.slug === capabilityAccess.slug
    ? capabilityAdmission
    : null;
  const legacySourceRef = useRef<LegacyNote | null>(null);
  const plainProviderCtor = (gate.plainProviderCtor ?? null) as PlainRuntime["PlainUpsertProvider"] | null;
  const [convertBusy, setConvertBusy] = useState(false);
  const convertError = gate.convertError;
  const convertBusyRef = useRef(false);
  const convertErrorRef = useRef<"network" | "permission" | "retry" | "converted" | null>(null);
  const [legacyBusyKind, setLegacyBusyKind] = useState<"on" | "off">("on");
  const patchGate = useCallback((partial: Partial<NoteHostGate>) => {
    if (!hostKey) return;
    getNoteHost(hostKey)?.setGate(partial);
  }, [hostKey]);
  useEffect(() => {
    convertErrorRef.current = convertError;
  }, [convertError]);

  // Bumped by the hashchange listener (lock/unlock) and by Retry on the
  // enc-meta error gate so the meta-fetch effect re-runs. Owned by the host
  // so sibling panes of the same note-identity share one revision (F2).
  const metaVersion = gate.metaVersion;
  const resolvedEncTarget = gate.resolvedEncTarget;
  const [resources, setResources] = useState<NoteResources | null>(null);
  const currentEncTargetRef = useRef<EncGateTarget>({ slug, metaVersion });
  const routerTarget = `${location.key}\u0000${location.pathname}\u0000${location.search}\u0000${location.hash}`;
  const routerTargetRef = useRef(routerTarget);
  const encTargetIsCurrent = resolvedEncTarget?.slug === slug
    && resolvedEncTarget.metaVersion === metaVersion;
  const resourcesAreCurrent = encPhase === "ready"
    && encTargetIsCurrent
    && resources?.slug === slug
    && resources.metaVersion === metaVersion
    && resources.providerEpoch === providerEpoch;
  const doc = resourcesAreCurrent ? resources.doc : null;
  const provider = resourcesAreCurrent ? resources.provider : null;
  const [writeFenced, setWriteFenced] = useState(false);

  const runConvert = useCallback(async () => {
    if (!doc || convertBusyRef.current || capabilityAccess || convertErrorRef.current === "converted") return;
    const startedSlug = slug;
    const startedMeta = metaVersion;
    convertBusyRef.current = true;
    setLegacyBusyKind("on");
    setConvertBusy(true);
    patchGate({ convertError: null });
    try {
      const runtime = capabilityRuntime ?? await loadCapabilityRuntime();
      const plain = plainRuntime ?? await loadPlainRuntime();
      const path = await plain.convertPlainNoteOnWrite({
        slug: startedSlug,
        doc,
        source: (hostKey ? getNoteHost(hostKey)?.legacySource as LegacyNote | null : null)
          ?? legacySourceRef.current,
        api: runtime.createCapabilityApi(),
        encryption,
        encryptionSecret: readEncryptionSecret(window.location.hash),
      });
      if (
        currentEncTargetRef.current.slug !== startedSlug
        || currentEncTargetRef.current.metaVersion !== startedMeta
      ) return;
      markLegacySecurePin(startedSlug);
      clearPlainNoteIndexedDb(startedSlug);
      navigate(path, { replace: true });
      toast({
        title: tRef.current("security.legacy_secure_success_on"),
      });
    } catch (error) {
      if (
        currentEncTargetRef.current.slug !== startedSlug
        || currentEncTargetRef.current.metaVersion !== startedMeta
      ) return;
      const kind = (plainRuntime ?? await loadPlainRuntime()).mapDuplicateFailure(error);
      const feedback = kind === "permission" || kind === "network" ? kind : "retry";
      convertErrorRef.current = feedback;
      patchGate({ convertError: feedback });
      if (provider && "emitConvertError" in provider) {
        (provider as { emitConvertError: (message: string) => void }).emitConvertError(feedback);
      }
      toast({
        title: tRef.current("security.legacy_secure_fail_on"),
        variant: "destructive",
      });
    } finally {
      convertBusyRef.current = false;
      setConvertBusy(false);
    }
  }, [capabilityAccess, doc, encryption, hostKey, metaVersion, navigate, patchGate, provider, slug]);

  const runDisable = useCallback(async () => {
    if (!doc || convertBusyRef.current || !capabilityAccess || capabilityAccess.scope !== "owner") return;
    const ownerAccess = capabilityAccess;
    const startedSlug = slug;
    const startedMeta = metaVersion;
    convertBusyRef.current = true;
    setLegacyBusyKind("off");
    setConvertBusy(true);
    patchGate({ convertError: null });
    try {
      const runtime = capabilityRuntime ?? await loadCapabilityRuntime();
      const { bytesToBase64 } = await import("@/lib/yjs/base64");
      const { extractTags } = await import("@/lib/tags");
      const content = doc.getText("content").toString();
      await runtime.createCapabilityApi().disableSecureNote({
        slug: startedSlug,
        ydocState: bytesToBase64(Y.encodeStateAsUpdate(doc)),
        content,
        charCount: content.length,
        tags: extractTags(content),
        isEncrypted: false,
        salt: null,
        check: null,
        iterations: null,
      }, ownerAccess.token);
      if (
        currentEncTargetRef.current.slug !== startedSlug
        || currentEncTargetRef.current.metaVersion !== startedMeta
      ) return;
      clearLegacySecurePin(startedSlug);
      clearNoteEncryptionPin(startedSlug);
      navigate(`/${startedSlug}`, { replace: true });
      toast({
        title: tRef.current("security.legacy_secure_success_off"),
      });
    } catch (error) {
      if (
        currentEncTargetRef.current.slug !== startedSlug
        || currentEncTargetRef.current.metaVersion !== startedMeta
      ) return;
      const kind = (plainRuntime ?? await loadPlainRuntime()).mapDuplicateFailure(error);
      const feedback = kind === "permission" || kind === "network" ? kind : "retry";
      convertErrorRef.current = feedback;
      patchGate({ convertError: feedback });
      toast({
        title: tRef.current("security.legacy_secure_fail_off"),
        variant: "destructive",
      });
    } finally {
      convertBusyRef.current = false;
      setConvertBusy(false);
    }
  }, [capabilityAccess, doc, metaVersion, navigate, patchGate, slug]);

  useEffect(() => {
    convertErrorRef.current = null;
    convertBusyRef.current = false;
    setConvertBusy(false);
  }, [slug]);

  useEffect(() => {
    setWriteFenced(false);
    if (!provider || !("onWriteFence" in provider)) return;
    const transitionProvider = provider as YjsProviderLike & {
      onWriteFence: (listener: (value: boolean) => void) => () => void;
    };
    return transitionProvider.onWriteFence(setWriteFenced);
  }, [provider]);

  const observeHash = useCallback((nextHash: string) => {
    if (!hostKey) return;
    getNoteHost(hostKey)?.observeHash(nextHash);
  }, [hostKey]);

  // Commit request identity only after React commits this render. Mutating the
  // ref during render lets an abandoned concurrent render invalidate the
  // still-mounted note's in-flight encryption request.
  useLayoutEffect(() => {
    currentEncTargetRef.current = { slug, metaVersion };
  }, [slug, metaVersion]);

  // acquireDoc() mutates a module-level cache and the provider constructor
  // registers global listeners. Do neither until the encryption gate has
  // authorized this exact target, then own both from a committed effect so
  // React can pair acquisition with cleanup, including StrictMode replays.
  // Same-note split panes bind through the tab-scoped host (H1–H4) so a
  // second pane never constructs a parallel provider/doc/session.
  useLayoutEffect(() => {
    if (
      !validSlug
      || !hostKey
      || encPhase !== "ready"
      || !encTargetIsCurrent
      || (capabilityAccess && !admittedCapability)
      || (convertError === "converted" && !capabilityAccess)
      || (
        !capabilityAccess
        && !legacyOnly
        && !plainProviderCtor
        && import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true"
      )
    ) return;
    const live = getNoteHost(hostKey);
    if (!live) return;
    const docCacheKey = admittedCapability
      ? `capability:${admittedCapability.session.noteId}:${admittedCapability.session.scope}:${admittedCapability.session.generation}`
      : slug;
    const generation = `${docCacheKey}:${metaVersion}:${providerEpoch}`;
    const bound = live.bindResources(generation, () => {
      const ownedDoc = acquireDoc(docCacheKey);
      const seed = plainRuntime?.consumeConvertSeed(slug);
      if (seed) Y.applyUpdate(ownedDoc, seed);
      const CapabilityYjsProvider = admittedCapability?.YjsProvider;
      const ownedProvider: YjsProviderLike = admittedCapability && CapabilityYjsProvider
        ? new CapabilityYjsProvider(
            admittedCapability.access,
            admittedCapability.session,
            ownedDoc,
            { pollingOnly: true },
          )
        : plainProviderCtor && !legacyOnly
          ? new plainProviderCtor(
              slug,
              ownedDoc,
              async (body, keepalive) => {
                const runtime = capabilityRuntime ?? await loadCapabilityRuntime();
                return runtime.createCapabilityApi().upsertPlainNote(body, keepalive);
              },
              () => {
                markLegacySecurePin(slug);
                convertErrorRef.current = "converted";
                getNoteHost(hostKey)?.setGate({ convertError: "converted" });
              },
            )
          : new SupabaseYjsProvider(slug, ownedDoc);
      return {
        doc: ownedDoc,
        provider: ownedProvider,
        dispose: () => {
          void ownedProvider.destroy();
          releaseDoc(docCacheKey);
        },
      };
    });
    setResources({
      slug,
      metaVersion,
      providerEpoch,
      doc: bound.doc as Y.Doc,
      provider: bound.provider as YjsProviderLike,
    });
    return () => {
      live.unbindResources(generation);
    };
  }, [
    slug,
    validSlug,
    hostKey,
    metaVersion,
    providerEpoch,
    encPhase,
    encTargetIsCurrent,
    capabilityAccess,
    capabilityToken,
    admittedCapability,
    legacyOnly,
    plainProviderCtor,
    convertError,
  ]);

  useLayoutEffect(() => {
    if (!hostKey) return;
    const live = getNoteHost(hostKey);
    if (!live) return;
    const syncHash = () => observeHash(window.location.hash);
    const stop = live.ownWindowEvents(["hashchange", "popstate"], syncHash);
    // Close the commit-to-subscription race by reconciling once immediately.
    syncHash();
    return stop;
  }, [observeHash, hostKey]);

  // React Router navigation can change/remove a fragment through
  // history.pushState(), which does not emit hashchange or popstate.
  useLayoutEffect(() => {
    if (routerTargetRef.current === routerTarget) return;
    routerTargetRef.current = routerTarget;
    observeHash(location.hash);
  }, [routerTarget, location.hash, observeHash]);

  // Single combined fetch: enc-meta + ydoc_state in one round-trip.
  useEffect(() => {
    if (!validSlug || !hostKey) return;
    const live = getNoteHost(hostKey);
    if (!live) return;
    const existing = live.getGate();
    if (
      existing.resolvedEncTarget?.slug === slug
      && existing.resolvedEncTarget.metaVersion === metaVersion
      && existing.encPhase !== "loading"
    ) {
      return;
    }
    live.setGate({ encPhase: "loading" });
    let cancelled = false;
    const requestTarget: EncGateTarget = { slug, metaVersion };
    const requestRouterTarget = routerTarget;
    const requestLocation = {
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
    };
    const isCurrentRequest = () => !cancelled
      && currentEncTargetRef.current.slug === requestTarget.slug
      && currentEncTargetRef.current.metaVersion === requestTarget.metaVersion
      && routerTargetRef.current === requestRouterTarget
      // BrowserRouter mutates window.history before a transition commits its
      // useLocation value. Never let old crypto authorize the new live URL in
      // that window between history mutation and React commit.
      && window.location.pathname === requestLocation.pathname
      && window.location.search === requestLocation.search
      && window.location.hash === requestLocation.hash;
    (async () => {
      try {
        let data: {
          is_encrypted?: boolean;
          enc_salt?: string | null;
          enc_check?: string | null;
          enc_iterations?: number | null;
          ydoc_state?: string | null;
        } | null = null;
        let rowExists = false;
        if (capabilityAccess) {
          const runtime = capabilityRuntime ?? await loadCapabilityRuntime();
          const session = await live.openOnce(
            `session:${capabilityAccess.token}:${metaVersion}`,
            () => runtime.createCapabilityApi().openSession(capabilityAccess.token),
          );
          if (!isCurrentRequest()) return;
          if (
            session.slug !== slug
            || session.scope !== capabilityAccess.scope
            || session.syncTransport !== "polling"
          ) {
            throw new Error("capability session unavailable");
          }
          convertErrorRef.current = null;
          live.setGate({
            convertError: null,
            capabilityAdmission: {
              access: capabilityAccess,
              session,
              YjsProvider: runtime.CapabilityYjsProvider,
            },
          });
          data = {
            is_encrypted: session.encryption.enabled,
            enc_salt: session.encryption.salt,
            enc_check: session.encryption.check,
            enc_iterations: session.encryption.iterations,
            ydoc_state: null,
          };
          rowExists = true;
        } else if (!legacyOnly && import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true") {
          live.setGate({ capabilityAdmission: null, plainProviderCtor: null });
          const runtime = plainRuntime ?? await loadPlainRuntime();
          if (!isCurrentRequest()) return;
          const note = await live.openOnce(
            `lno:${slug}:${metaVersion}`,
            () => runtime.createLegacyNoteApi().open(slug),
          );
          if (!isCurrentRequest()) return;
          // LNO-wins: leftover pin after bulk OFF must not latch A3. Only
          // clear after a successful unmanaged/vacant open. LNO errors keep
          // the pin (fail-closed) via the catch path.
          if (hasLegacySecurePin(slug)) clearLegacySecurePin(slug);
          legacySourceRef.current = note;
          live.legacySource = note;
          live.setGate({ plainProviderCtor: runtime.PlainUpsertProvider });
          if (!note) {
            data = {
              is_encrypted: false,
              enc_salt: null,
              enc_check: null,
              enc_iterations: null,
              ydoc_state: null,
            };
            rowExists = false;
          } else {
            data = {
              is_encrypted: note.isEncrypted,
              enc_salt: note.salt,
              enc_check: note.check,
              enc_iterations: note.iterations,
              ydoc_state: note.ydocState,
            };
            rowExists = true;
          }
        } else {
          live.setGate({ capabilityAdmission: null });
          legacySourceRef.current = null;
          live.legacySource = null;
          const response = await live.openOnce(
            `notes:${slug}:${metaVersion}`,
            async () => supabase
              .from("notes")
              .select("is_encrypted, enc_salt, enc_check, enc_iterations, ydoc_state")
              .eq("slug", slug)
              .maybeSingle(),
          );
          if (response.error) throw response.error;
          data = response.data;
          rowExists = !!response.data;
        }
        if (!isCurrentRequest()) return;
        const meta: EncMeta = {
          isEncrypted: !!data?.is_encrypted,
          salt: data?.enc_salt ?? null,
          check: data?.enc_check ?? null,
          iterations: data?.enc_iterations ?? null,
          ydocState: data?.ydoc_state ?? null,
          rowExists,
        };
        const prevMeta = live.getGate().encMeta;
        live.setGate({
          encMeta: meta,
          ...(prevMeta.isEncrypted !== meta.isEncrypted
            ? { providerEpoch: live.getGate().providerEpoch + 1 }
            : {}),
        });

        // The legacy table still permits an attacker to alter encryption
        // metadata until the capability cutover. Remember every encrypted
        // observation locally and reject a later plaintext/missing response.
        // localStorage is synchronous, so the pin is committed before any
        // document, provider, IndexedDB store, editor, preview, or snapshot can
        // mount for this response.
        const encryptionStateIsTrusted = meta.isEncrypted
          ? markNoteEncrypted(slug)
          : getEncryptionPinState(slug) === "clear";
        if (!encryptionStateIsTrusted) {
          if (!isCurrentRequest()) return;
          live.setGate({
            encryption: null,
            encPhase: "blocked",
            resolvedEncTarget: requestTarget,
          });
          return;
        }

        if (!meta.isEncrypted) {
          if (!isCurrentRequest()) return;
          live.setGate({
            encryption: null,
            encPhase: "ready",
            resolvedEncTarget: requestTarget,
          });
          return;
        }
        const hashKey = readEncryptionSecret(window.location.hash);
        if (hashKey && meta.salt && meta.check) {
          try {
            const key = await deriveKey(hashKey, meta.salt, iterationsFor(meta.iterations));
            if (!isCurrentRequest()) return;
            const ok = await verifyCheck(key, meta.check);
            if (!isCurrentRequest()) return;
            if (ok) {
              live.setGate({
                encryption: {
                  encrypt: (b) => encryptBytes(key, b),
                  decrypt: (b) => decryptBytes(key, b),
                },
                encPhase: "ready",
                resolvedEncTarget: requestTarget,
              });
              return;
            }
          } catch (e) {
            if (!isCurrentRequest()) return;
            console.warn("derive failed", e);
          }
        }
        if (!isCurrentRequest()) return;
        live.setGate({ encPhase: "needs-key", resolvedEncTarget: requestTarget });
      } catch (error) {
        if (isCurrentRequest()) {
          if (!capabilityAccess) {
            try {
              const plain = plainRuntime ?? await loadPlainRuntime();
              if (plain.mapDuplicateFailure(error) === "converted") {
                markLegacySecurePin(slug);
                convertErrorRef.current = "converted";
                live.setGate({
                  convertError: "converted",
                  plainProviderCtor: null,
                  encryption: null,
                  encPhase: "ready",
                  resolvedEncTarget: requestTarget,
                });
                return;
              }
            } catch {
              // Fall through to the retryable metadata gate.
            }
          }
          console.warn("Encryption metadata query failed");
          live.setGate({ encPhase: "error", resolvedEncTarget: requestTarget });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    slug,
    validSlug,
    hostKey,
    metaVersion,
    capabilityAccess,
    capabilityToken,
    legacyOnly,
    routerTarget,
  ]);

  // A sibling tab (native storage event) or this tab's Legacy ON (custom event)
  // can pin the slug while a bare free-edit workspace is live. Close it to the
  // need-owner banner instead of keeping IndexedDB «Synced» with no durable write.
  useEffect(() => {
    if (!validSlug || capabilityAccess) return;

    const applyLegacySecurePin = () => {
      if (hasLegacySecurePin(slug)) {
        convertErrorRef.current = "converted";
        patchGate({ convertError: "converted", plainProviderCtor: null });
        return;
      }
      if (convertErrorRef.current !== "converted") return;
      convertErrorRef.current = null;
      patchGate({ convertError: null });
      if (hostKey) getNoteHost(hostKey)?.bumpMeta();
    };
    const onLegacySecureStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== legacySecurePinKey(slug)) return;
      applyLegacySecurePin();
    };
    const onLegacySecureLocal = (event: Event) => {
      const changedSlug = (event as CustomEvent<{ slug?: string }>).detail?.slug;
      if (changedSlug !== slug) return;
      applyLegacySecurePin();
    };

    window.addEventListener("storage", onLegacySecureStorage);
    window.addEventListener(LEGACY_SECURE_PIN_CHANGE_EVENT, onLegacySecureLocal);
    return () => {
      window.removeEventListener("storage", onLegacySecureStorage);
      window.removeEventListener(LEGACY_SECURE_PIN_CHANGE_EVENT, onLegacySecureLocal);
    };
  }, [slug, validSlug, capabilityAccess, hostKey, patchGate]);

  useEffect(() => {
    if (!validSlug || convertError !== "converted" || capabilityAccess) return;
    clearPlainNoteIndexedDb(slug);
  }, [slug, validSlug, convertError, capabilityAccess]);

  // A sibling tab (native storage event) or a same-tab lock/decrypt flow
  // (custom event) can change the durable pin while this provider is live.
  // Close the workspace immediately; provider-level guards independently
  // reject any write racing this React state transition.
  useEffect(() => {
    if (!validSlug || encPhase !== "ready" || !encTargetIsCurrent) return;

    const closeIfPinChanged = () => {
      const pinState = getEncryptionPinState(slug);
      const stillTrusted = encMeta.isEncrypted
        ? pinState === "pinned"
        : pinState === "clear";
      if (stillTrusted) return;
      patchGate({ encryption: null, encPhase: "blocked" });
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== encryptionPinStorageKey(slug)) return;
      closeIfPinChanged();
    };
    const onLocalPinChange = (event: Event) => {
      const changedSlug = (event as CustomEvent<{ slug?: string }>).detail?.slug;
      if (changedSlug !== slug) return;
      closeIfPinChanged();
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(ENCRYPTION_PIN_CHANGE_EVENT, onLocalPinChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(ENCRYPTION_PIN_CHANGE_EVENT, onLocalPinChange);
    };
  }, [slug, validSlug, encPhase, encTargetIsCurrent, encMeta.isEncrypted, patchGate]);

  // When inside the Syrin Note Chrome extension side panel, tell the host
  // which slug we're on so it can remember the last-opened note. We retry
  // up to 3 times (1s apart) if the host doesn't ack within 500ms — covers
  // the race where the side panel's listener attaches after our first post.
  useEffect(() => {
    if (!isExtensionContext || !validSlug || embedSlug) return;
    if (typeof window === "undefined" || window.parent === window) return;
    const debug = (() => {
      try {
        return localStorage.getItem("syrin:debug") === "1";
      } catch {
        return false;
      }
    })();
    const dlog = (...args: unknown[]) => {
      if (debug) console.log("[syrin-note][debug][web]", ...args);
    };
    // Strict origin: derive from document.referrer (the extension host).
    let targetOrigin = "*";
    try {
      if (document.referrer) targetOrigin = new URL(document.referrer).origin;
    } catch {
      /* keep "*" */
    }
    let acked = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent) return;
      const d = e.data;
      if (d && typeof d === "object" && d.type === "syrin:ack" && d.slug === slug) {
        acked = true;
        dlog("ack received", "locatorLength=", slug.length, "after attempts=", attempts);
        if (timer) clearTimeout(timer);
      }
    };
    window.addEventListener("message", onMessage);
    const sendOnce = () => {
      try {
        window.parent.postMessage({
          type: "syrin:slug",
          slug,
          ...(capabilityAccess?.scope === "edit"
            ? { editCapability: capabilityAccess.token }
            : {}),
        }, targetOrigin);
        dlog(
          "posted locator",
          "locatorLength=",
          slug.length,
          "targetOrigin=",
          targetOrigin,
          "attempt",
          attempts + 1,
        );
      } catch (err) {
        dlog("post failed", err);
      }
      attempts += 1;
      timer = setTimeout(() => {
        if (acked) return;
        if (attempts >= 3) {
          dlog("giving up after 3 attempts");
          return;
        }
        sendOnce();
      }, attempts === 1 ? 500 : 1000);
    };
    sendOnce();
    return () => {
      window.removeEventListener("message", onMessage);
      if (timer) clearTimeout(timer);
    };
  }, [slug, validSlug, embedSlug, capabilityAccess, capabilityToken]);



  // Mount IDB + connect provider once enc decision is made.
  // Host startSync owns IDB/connect/awareness-local/snapshots so a second pane
  // cannot admit a ghost self (F1) or a second IndexedDB persistence.
  useEffect(() => {
    if (!validSlug || !hostKey || !doc || !provider || encPhase !== "ready" || !encTargetIsCurrent) return;
    const live = getNoteHost(hostKey);
    if (!live) return;
    provider.setEncryption(encryption);
    provider.setExpectedEncrypted(encMeta.isEncrypted);

    const identity = getIdentity();
    if (!embedSlug && !capabilityAccess) touchRecent(slug);
    rememberMetadata(slug);
    void hydrateNoteIndex();

    const indexDurable = !encMeta.isEncrypted && !capabilityAccess;
    const generation = `${slug}:${metaVersion}:${providerEpoch}`;
    const stopSync = live.startSync(generation, () => {
      const idb = !capabilityAccess && !encMeta.isEncrypted
        ? new IndexeddbPersistence(`note:${slug}`, doc)
        : null;
      let disposed = false;
      const unsubSync = provider.onSyncEvent((ev) => {
        if (ev.type === "recovered") {
          toast({
            title: tRef.current("toast.synced_remote"),
            description: tRef.current("toast.synced_remote_desc", { bytes: ev.bytes }),
          });
        }
      });
      const ytext = doc.getText("content");
      const snapshotProtection = encMeta.isEncrypted ? encryption : null;
      const snapshotsEnabled = !capabilityAccess;
      let prevContent = ytext.toString();
      let lastBigDeleteAt = 0;
      const onDocChange = () => {
        const text = ytext.toString();
        const removed = prevContent.length - text.length;
        const now = Date.now();
        if (
          snapshotsEnabled &&
          removed > SUDDEN_DELETE_THRESHOLD &&
          now - lastBigDeleteAt > SUDDEN_DELETE_WINDOW_MS &&
          prevContent.length >= SUDDEN_DELETE_THRESHOLD
        ) {
          lastBigDeleteAt = now;
          void recordOnSuddenDelete(slug, prevContent, snapshotProtection);
        }
        prevContent = text;
      };
      ytext.observe(onDocChange);

      (idb?.whenSynced ?? Promise.resolve()).then(() => {
        if (disposed) return;
        return provider
          .connect(identity, {
            prefetchedYdocState: encMeta.ydocState,
            rowExists: encMeta.rowExists,
          })
          .catch((e) => console.warn("Provider connect failed", e));
      }).then(() => {
        if (disposed) return;
        applyTemplateSeedIfEmpty(ytext, slug);
        prevContent = ytext.toString();
        if (snapshotsEnabled) {
          void maybeSaveSnapshot(slug, prevContent, snapshotProtection);
        }
      });

      let snapshotTimer: number | null = null;
      const onVisibility = () => {
        if (disposed) return;
        if (document.visibilityState === "hidden") {
          if (snapshotTimer !== null) window.clearInterval(snapshotTimer);
          snapshotTimer = null;
          void maybeSaveSnapshot(slug, ytext.toString(), snapshotProtection);
        } else {
          snapshotTimer = window.setInterval(() => {
            void maybeSaveSnapshot(slug, ytext.toString(), snapshotProtection);
          }, SNAPSHOT_INTERVAL_MS);
        }
      };
      if (snapshotsEnabled) {
        snapshotTimer = window.setInterval(() => {
          void maybeSaveSnapshot(slug, ytext.toString(), snapshotProtection);
        }, SNAPSHOT_INTERVAL_MS);
        document.addEventListener("visibilitychange", onVisibility);
      }

      const handleBeforeUnload = () => {
        if (disposed) return;
        provider.flushBeacon();
      };
      window.addEventListener("beforeunload", handleBeforeUnload);
      window.addEventListener("pagehide", handleBeforeUnload);

      return () => {
        disposed = true;
        window.removeEventListener("beforeunload", handleBeforeUnload);
        window.removeEventListener("pagehide", handleBeforeUnload);
        if (snapshotsEnabled) document.removeEventListener("visibilitychange", onVisibility);
        if (snapshotTimer !== null) window.clearInterval(snapshotTimer);
        ytext.unobserve(onDocChange);
        unsubSync();
        idb?.destroy();
      };
    });

    const unsubAwareness = provider.onAwareness((states) => {
      const list: PresenceUser[] = [];
      states.forEach((state, clientId) => {
        if (state?.user) {
          list.push({ clientId, name: state.user.name, color: state.user.color });
        }
      });
      setUsers(list);
    });

    const ytext = doc.getText("content");
    let countTimer: number | null = null;
    let indexTimer: number | null = null;
    const updateCounts = () => {
      const text = ytext.toString();
      const chars = text.length;
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      setCounts({ chars, words });
    };
    const scheduleCounts = () => {
      if (countTimer) window.clearTimeout(countTimer);
      countTimer = window.setTimeout(updateCounts, COUNT_DEBOUNCE_MS);
      if (indexTimer) window.clearTimeout(indexTimer);
      indexTimer = window.setTimeout(() => {
        upsertPlaintextNote(slug, ytext.toString(), { durable: indexDurable });
      }, 200);
    };
    updateCounts();
    upsertPlaintextNote(slug, ytext.toString(), { durable: indexDurable });
    ytext.observe(scheduleCounts);

    return () => {
      stopSync();
      if (countTimer) window.clearTimeout(countTimer);
      if (indexTimer) window.clearTimeout(indexTimer);
      ytext.unobserve(scheduleCounts);
      unsubAwareness();
    };
  }, [
    slug,
    validSlug,
    hostKey,
    doc,
    provider,
    embedSlug,
    encPhase,
    encTargetIsCurrent,
    encryption,
    encMeta.isEncrypted,
    encMeta.ydocState,
    encMeta.rowExists,
    metaVersion,
    providerEpoch,
    capabilityAccess,
    capabilityToken,
    plainProviderCtor,
  ]);

  if (!validSlug) return <Navigate to="/" replace />;

  // This gate deliberately precedes both render branches. In particular,
  // SplitView's embedded branch must never mount Editor/Preview behind an
  // overlay while encryption metadata or a decryption key is unavailable.
  const visibleEncPhase = encTargetIsCurrent ? encPhase : "loading";
  if (visibleEncPhase !== "ready") {
    const gate = visibleEncPhase === "blocked" ? (
      <div
        className="mx-auto max-w-md space-y-2 px-6 text-center"
        role="alert"
      >
        <p className="font-medium text-destructive">{t("unlock.metadata_conflict")}</p>
        <p className="text-sm text-muted-foreground">{t("unlock.metadata_conflict_desc")}</p>
      </div>
    ) : visibleEncPhase === "error" ? (
      <div
        className="mx-auto max-w-md space-y-2 px-6 text-center"
        role="alert"
      >
        <p className="font-medium text-destructive">{t("unlock.metadata_unavailable")}</p>
        <p className="text-sm text-muted-foreground">{t("unlock.metadata_unavailable_desc")}</p>
        <Button type="button" onClick={() => hostKey && getNoteHost(hostKey)?.bumpMeta()}>
          {t("common.retry")}
        </Button>
      </div>
    ) : visibleEncPhase === "needs-key" ? (
      <UnlockForm
        slug={slug}
        salt={encMeta.salt!}
        check={encMeta.check!}
        iterations={iterationsFor(encMeta.iterations)}
        embedded={!!embedSlug}
        onUnlock={(key) => {
          const currentTarget = currentEncTargetRef.current;
          if (currentTarget.slug !== slug || currentTarget.metaVersion !== metaVersion) return;
          if (resolvedEncTarget?.slug !== slug || resolvedEncTarget.metaVersion !== metaVersion) return;
          // UnlockForm writes the adopted key with history.replaceState(), so
          // no navigation event will update our observer. Adopt it here
          // without starting another metadata request; a later removal must
          // still be detected and close the gate.
          const liveHost = hostKey ? getNoteHost(hostKey) : null;
          liveHost?.adoptHash(window.location.hash);
          // replaceState() emits no browser navigation event. Notify every
          // other mounted gate (notably a distinct-slug SplitView sibling)
          // after this host adopts the hash, so a key replaced elsewhere cannot
          // leave stale plaintext mounted.
          window.dispatchEvent(new Event("hashchange"));
          liveHost?.setGate({
            encryption: {
              encrypt: (b) => encryptBytes(key, b),
              decrypt: (b) => decryptBytes(key, b),
            },
            encPhase: "ready",
          });
        }}
      />
    ) : (
      <div
        className="flex h-full items-center justify-center"
        aria-busy="true"
        aria-live="polite"
      >
        <Loader2
          className="h-5 w-5 motion-safe:animate-spin text-muted-foreground"
          aria-hidden="true"
        />
        <span className="sr-only">{t("common.loading")}</span>
      </div>
    );

    if (embedSlug) {
      return <div className="h-full min-h-0 bg-background">{gate}</div>;
    }
    return (
      <AppShell className="flex h-svh flex-col">
        <main className="flex flex-1 min-h-0 items-center justify-center">{gate}</main>
      </AppShell>
    );
  }

  if (convertError === "converted" && !capabilityAccess) {
    const body = (
      <div className="mx-auto max-w-md space-y-3 px-6 text-center" role="status">
        <p className="text-sm text-foreground">{t("security.legacy_secure_reopen_banner")}</p>
        <Button
          type="button"
          size="lg"
          className="min-h-11 min-w-11 px-4"
          onClick={() => navigate("/")}
        >
          {t("security.legacy_secure_reopen_cta")}
        </Button>
      </div>
    );
    if (embedSlug) {
      return <div className="h-full min-h-0 bg-background">{body}</div>;
    }
    return (
      <AppShell className="flex h-svh flex-col">
        <main className="flex flex-1 min-h-0 items-center justify-center">{body}</main>
      </AppShell>
    );
  }

  // SplitView wraps each panel — render the workspace without the global topbar.
  // SplitView wraps each panel — render compact topbar + editor (+ preview if toggled).
  // Compact topbar hides app-wide toggles (zen, theme, settings) but keeps
  // per-note actions (preview toggle, lock, share, rename, status, presence).
  // The ready phase schedules resource acquisition in a layout effect. Keep
  // the workspace closed for that single commit until its owned pair exists.
  if (!doc || !provider) return null;
  const isManaged = !!capabilityAccess;
  const legacyContainment = legacyOnly || !capabilityAccess;
  const allowEncryptionTransitions = !legacyOnly && !isManaged;
  const getContent = () => doc.getText("content").toString();
  const getEditorSelection = () => editorRef.current?.getSelectedText() ?? "";
  const legacyEncryptionSecret = legacyContainment ? readEncryptionSecret(location.hash) : "";
  const currentShareUrl = legacyContainment && typeof window !== "undefined"
    ? `${window.location.origin}/${slug}${
      legacyEncryptionSecret ? `#${encodeURIComponent(legacyEncryptionSecret)}` : ""
    }`
    : undefined;
  const convertChrome = (convertBusy || (convertError && convertError !== "converted")) ? (
    <div
      className="flex min-h-11 flex-wrap items-center gap-2 border-b bg-muted px-3 py-2 text-sm text-foreground"
      role={convertError ? "alert" : "status"}
      aria-busy={convertBusy || undefined}
    >
      <p className="flex-1">
        {convertBusy
          ? t(legacyBusyKind === "off" ? "security.legacy_secure_busy_off" : "security.legacy_secure_busy_on")
          : t(legacyBusyKind === "off" ? "security.legacy_secure_fail_off" : "security.legacy_secure_fail_on")}
      </p>
      {convertError && (
        <Button type="button" size="lg" className="min-h-11 min-w-11 px-4" onClick={() => void (legacyBusyKind === "off" ? runDisable() : runConvert())}>
          {t("security.convert_retry")}
        </Button>
      )}
    </div>
  ) : null;

  if (embedSlug) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <Topbar
          slug={slug}
          doc={doc}
          provider={provider}
          charCount={counts.chars}
          wordCount={counts.words}
          users={users}
          showPreview={showPreview}
          onTogglePreview={() => setShowPreview((v) => !v)}
          scrollSync={scrollSync}
          onToggleScrollSync={toggleScrollSync}
          zen={zen}
          onToggleZen={toggleZen}
          typewriter={typewriter}
          onToggleTypewriter={toggleTypewriter}
          focusLine={focusLine}
          onToggleFocusLine={toggleFocusLine}
          getContent={() => doc.getText("content").toString()}
          getEditorSelection={getEditorSelection}
          isEncrypted={encMeta.isEncrypted}
          encryption={encryption}
          capabilityAccess={capabilityAccess}
          allowEncryptionTransitions={allowEncryptionTransitions}
          legacyOn={!!capabilityAccess}
          onLegacyEnable={!capabilityAccess && !legacyOnly ? () => { void runConvert(); } : undefined}
          onLegacyDisable={capabilityAccess?.scope === "owner" ? () => { void runDisable(); } : undefined}
          loading={convertBusy}
          currentShareUrl={currentShareUrl}
          paginated={paginated}
          onTogglePagination={togglePagination}
          compact
          narrowOverride={narrow}
        />
        {convertChrome}
        <div
          className={
            narrow
              ? "flex flex-1 min-h-0 flex-col"
              : "flex flex-1 min-h-0 flex-col divide-y divide-border md:flex-row md:divide-x md:divide-y-0"
          }
        >
          {showEditorPane && (
            <div className="flex-1 min-h-0 min-w-0">
              <Editor
                ref={editorRef}
                doc={doc}
                awareness={provider.awareness}
                className="h-full min-h-0 overflow-hidden"
                onScrollEl={setEditorScrollEl}
                vim={vim}
                editable={!writeFenced}
              />
            </div>
          )}
          {showPreviewPane && (
            <div
              ref={setPreviewScrollEl}
              className="flex-1 min-h-0 min-w-0 overflow-auto bg-muted/30"
            >
              <Preview doc={doc} slug={slug} />
            </div>
          )}
        </div>
      </div>
    );
  }

  const noteUrl = `https://note.syrin.online/${slug}`;
  const noteTitle = `${slug} — Syrin Notes`;
  const noteDesc = `Note "${slug}" on Syrin Notes — realtime markdown, autosave, synced across devices.`;

  return (
    <AppShell className="flex h-svh flex-col">


      <Helmet>
        <title>{noteTitle}</title>
        <meta name="description" content={noteDesc} />
        <link rel="canonical" href={noteUrl} />
        <meta property="og:title" content={noteTitle} />
        <meta property="og:description" content={noteDesc} />
        <meta property="og:url" content={noteUrl} />
        {/* eslint-disable-next-line no-restricted-syntax -- SEO control value */}
        <meta property="og:type" content="article" />
        <meta name="twitter:title" content={noteTitle} />
        <meta name="twitter:description" content={noteDesc} />
        {/* eslint-disable-next-line no-restricted-syntax -- SEO control value */}
        {encMeta.isEncrypted && <meta name="robots" content="noindex" />}
      </Helmet>
      <Topbar
        slug={slug}
        doc={doc}
        provider={provider}
        charCount={counts.chars}
        wordCount={counts.words}
        users={users}
        showPreview={showPreview}
        onTogglePreview={() => setShowPreview((v) => !v)}
        scrollSync={scrollSync}
        onToggleScrollSync={toggleScrollSync}
        zen={zen}
        onToggleZen={toggleZen}
        typewriter={typewriter}
        onToggleTypewriter={toggleTypewriter}
        focusLine={focusLine}
        onToggleFocusLine={toggleFocusLine}
        getContent={getContent}
        getEditorSelection={getEditorSelection}
        isEncrypted={encMeta.isEncrypted}
        encryption={encryption}
        capabilityAccess={capabilityAccess}
        allowEncryptionTransitions={allowEncryptionTransitions}
        legacyOn={!!capabilityAccess}
        onLegacyEnable={!capabilityAccess && !legacyOnly ? () => { void runConvert(); } : undefined}
        onLegacyDisable={capabilityAccess?.scope === "owner" ? () => { void runDisable(); } : undefined}
        loading={convertBusy}
        currentShareUrl={currentShareUrl}
        paginated={paginated}
        onTogglePagination={togglePagination}
        outlineOpen={outlineOpen}
        onToggleOutline={() => setOutlineOpen((open) => !open)}
        outlineTriggerRef={outlineTriggerRef}
      />
      {convertChrome}

      <div className="flex min-h-0 flex-1">
        <OutlineSidebar
          id="note-outline"
          slug={slug}
          doc={doc}
          open={outlineOpen}
          onOpenChange={setOutlineOpen}
          onJump={(line) => editorRef.current?.jumpToLine(line)}
          onOpenNote={(target) => navigate("/" + target)}
          triggerRef={outlineTriggerRef}
        />
        <main
          className={
            narrow
              ? "relative flex min-h-0 min-w-0 flex-1 flex-col"
              : "relative flex min-h-0 min-w-0 flex-1 flex-col divide-y divide-border md:flex-row md:divide-x md:divide-y-0"
          }
        >
          {showEditorPane && (
            <div className="flex-1 min-h-0 min-w-0">
              <Editor
                ref={editorRef}
                doc={doc}
                awareness={provider.awareness}
                editable={!writeFenced}
                className="h-full min-h-0 overflow-hidden"
                onScrollEl={setEditorScrollEl}
                vim={vim}
              />
            </div>
          )}
          {showPreviewPane && (
            <div
              ref={setPreviewScrollEl}
              className={`flex-1 min-h-0 min-w-0 overflow-auto bg-muted/30 ${zen ? "zen-hide" : ""}`}
            >
              <Preview doc={doc} slug={slug} />
            </div>
          )}
        </main>
      </div>

      <GoalConfetti trigger={confettiTrigger} />

      {paginated && (
        <PageIndicator
          page={page}
          totalPages={totalPages}
          onPrev={() => flip(-1)}
          onNext={() => flip(1)}
        />
      )}
    </AppShell>
  );
}
