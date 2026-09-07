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
import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { isExtensionContext } from "@/lib/ext-context";
import {
  ENCRYPTION_PIN_CHANGE_EVENT,
  encryptionPinStorageKey,
  getEncryptionPinState,
  markNoteEncrypted,
} from "@/lib/encryption-pin";

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

let capabilityRuntime: CapabilityRuntime | undefined;
let capabilityRuntimePromise: Promise<CapabilityRuntime> | undefined;

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
  const [providerEpoch, setProviderEpoch] = useState(0);

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
  const [encPhase, setEncPhase] = useState<"loading" | "needs-key" | "blocked" | "error" | "ready">("loading");
  const [encMeta, setEncMeta] = useState<EncMeta>({
    isEncrypted: false,
    salt: null,
    check: null,
    iterations: null,
    ydocState: null,
    rowExists: false,
  });
  const [encryption, setEncryption] = useState<Encryption | null>(null);
  const [capabilityAdmission, setCapabilityAdmission] = useState<CapabilityAdmission | null>(null);
  const admittedCapability = capabilityAccess
    && capabilityAdmission
    && capabilityAdmission.access.token === capabilityAccess.token
    && capabilityAdmission.access.scope === capabilityAccess.scope
    && capabilityAdmission.access.slug === capabilityAccess.slug
    ? capabilityAdmission
    : null;

  // Bumped by the hashchange listener (lock/unlock) and by Retry on the
  // enc-meta error gate so the meta-fetch effect re-runs.
  const [metaVersion, setMetaVersion] = useState(0);
  const [resolvedEncTarget, setResolvedEncTarget] = useState<EncGateTarget | null>(null);
  const [resources, setResources] = useState<NoteResources | null>(null);
  const currentEncTargetRef = useRef<EncGateTarget>({ slug, metaVersion });
  const observedHashRef = useRef(window.location.hash);
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

  useEffect(() => {
    setWriteFenced(false);
    if (!provider || !("onWriteFence" in provider)) return;
    const transitionProvider = provider as YjsProviderLike & {
      onWriteFence: (listener: (value: boolean) => void) => () => void;
    };
    return transitionProvider.onWriteFence(setWriteFenced);
  }, [provider]);

  const observeHash = useCallback((nextHash: string) => {
    if (observedHashRef.current === nextHash) return;
    observedHashRef.current = nextHash;
    setMetaVersion((n) => n + 1);
  }, []);

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
  useLayoutEffect(() => {
    if (
      !validSlug
      || encPhase !== "ready"
      || !encTargetIsCurrent
      || (capabilityAccess && !admittedCapability)
    ) return;
    const docCacheKey = admittedCapability
      ? `capability:${admittedCapability.session.noteId}:${admittedCapability.session.scope}:${admittedCapability.session.generation}`
      : slug;
    const ownedDoc = acquireDoc(docCacheKey);
    const CapabilityYjsProvider = admittedCapability?.YjsProvider;
    const ownedProvider: YjsProviderLike = admittedCapability && CapabilityYjsProvider
      ? new CapabilityYjsProvider(
          admittedCapability.access,
          admittedCapability.session,
          ownedDoc,
          { pollingOnly: true },
        )
      : new SupabaseYjsProvider(slug, ownedDoc);
    setResources({
      slug,
      metaVersion,
      providerEpoch,
      doc: ownedDoc,
      provider: ownedProvider,
    });
    return () => {
      void ownedProvider.destroy();
      releaseDoc(docCacheKey);
    };
  }, [
    slug,
    validSlug,
    metaVersion,
    providerEpoch,
    encPhase,
    encTargetIsCurrent,
    capabilityAccess,
    capabilityToken,
    admittedCapability,
  ]);

  useLayoutEffect(() => {
    const syncHash = () => observeHash(window.location.hash);
    window.addEventListener("hashchange", syncHash);
    window.addEventListener("popstate", syncHash);
    // Close the commit-to-subscription race by reconciling once immediately.
    syncHash();
    return () => {
      window.removeEventListener("hashchange", syncHash);
      window.removeEventListener("popstate", syncHash);
    };
  }, [observeHash]);

  // React Router navigation can change/remove a fragment through
  // history.pushState(), which does not emit hashchange or popstate.
  useLayoutEffect(() => {
    if (routerTargetRef.current === routerTarget) return;
    routerTargetRef.current = routerTarget;
    observeHash(location.hash);
  }, [routerTarget, location.hash, observeHash]);

  // Single combined fetch: enc-meta + ydoc_state in one round-trip.
  useEffect(() => {
    if (!validSlug) return;
    setEncPhase("loading");
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
          const session = await runtime.createCapabilityApi().openSession(capabilityAccess.token);
          if (!isCurrentRequest()) return;
          if (
            session.slug !== slug
            || session.scope !== capabilityAccess.scope
            || session.syncTransport !== "polling"
          ) {
            throw new Error("capability session unavailable");
          }
          setCapabilityAdmission({
            access: capabilityAccess,
            session,
            YjsProvider: runtime.CapabilityYjsProvider,
          });
          data = {
            is_encrypted: session.encryption.enabled,
            enc_salt: session.encryption.salt,
            enc_check: session.encryption.check,
            enc_iterations: session.encryption.iterations,
            ydoc_state: null,
          };
          rowExists = true;
        } else {
          setCapabilityAdmission(null);
          const response = await supabase
            .from("notes")
            .select("is_encrypted, enc_salt, enc_check, enc_iterations, ydoc_state")
            .eq("slug", slug)
            .maybeSingle();
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
        setEncMeta((prev) => {
          // Encryption mode flipped since last fetch — force a provider rebuild.
          if (prev.isEncrypted !== meta.isEncrypted) {
            setProviderEpoch((n) => n + 1);
          }
          return meta;
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
          setEncryption(null);
          setEncPhase("blocked");
          setResolvedEncTarget(requestTarget);
          return;
        }

        if (!meta.isEncrypted) {
          if (!isCurrentRequest()) return;
          setEncryption(null);
          setEncPhase("ready");
          setResolvedEncTarget(requestTarget);
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
              setEncryption({
                encrypt: (b) => encryptBytes(key, b),
                decrypt: (b) => decryptBytes(key, b),
              });
              setEncPhase("ready");
              setResolvedEncTarget(requestTarget);
              return;
            }
          } catch (e) {
            if (!isCurrentRequest()) return;
            console.warn("derive failed", e);
          }
        }
        if (!isCurrentRequest()) return;
        setEncPhase("needs-key");
        setResolvedEncTarget(requestTarget);
      } catch {
        if (isCurrentRequest()) {
          console.warn("Encryption metadata query failed");
          setEncPhase("error");
          setResolvedEncTarget(requestTarget);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    slug,
    validSlug,
    metaVersion,
    capabilityAccess,
    capabilityToken,
    routerTarget,
  ]);

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
      setEncryption(null);
      setEncPhase("blocked");
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
  }, [slug, validSlug, encPhase, encTargetIsCurrent, encMeta.isEncrypted]);

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
  useEffect(() => {
    if (!validSlug || !doc || !provider || encPhase !== "ready" || !encTargetIsCurrent) return;
    provider.setEncryption(encryption);
    provider.setExpectedEncrypted(encMeta.isEncrypted);

    const identity = getIdentity();
    if (!embedSlug && !capabilityAccess) touchRecent(slug);
    rememberMetadata(slug);
    void hydrateNoteIndex();

    // y-indexeddb stores Yjs structs as plaintext. Capability outbox replaces
    // it for secure notes, and encrypted legacy notes must not mount it.
    const idb = !capabilityAccess && !encMeta.isEncrypted
      ? new IndexeddbPersistence(`note:${slug}`, doc)
      : null;
    // Knowledge index: live Y.Text after this gate only. Never scan y-indexeddb
    // (`note:${slug}`) for encrypted notes. Persist derived graphs only when
    // this note is already plaintext on device.
    const indexDurable = !encMeta.isEncrypted && !capabilityAccess;
    let disposed = false;

    
    const unsubAwareness = provider.onAwareness((states) => {
      const list: PresenceUser[] = [];
      states.forEach((state, clientId) => {
        if (state?.user) {
          list.push({ clientId, name: state.user.name, color: state.user.color });
        }
      });
      setUsers(list);
    });

    // Phase 2.2 — toast on `recovered` (DB had updates we didn't on reconnect).
    // Conflict events are surfaced by SyncIndicator's pill+popover, not a toast.
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

    // Debounced counts: avoid string scan + setState on every keystroke.
    let countTimer: number | null = null;
    let indexTimer: number | null = null;
    const updateCounts = () => {
      const text = ytext.toString();
      const chars = text.length;
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      setCounts({ chars, words });

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
      updateCounts();
      upsertPlaintextNote(slug, prevContent, { durable: indexDurable });
      if (snapshotsEnabled) {
        void maybeSaveSnapshot(slug, prevContent, snapshotProtection);
      }
    });

    // Pause snapshot interval while tab hidden; flush when visible again.
    let snapshotTimer: number | null = null;
    const onVisibility = () => {
      if (disposed) return;
      if (document.visibilityState === "hidden") {
        if (snapshotTimer !== null) window.clearInterval(snapshotTimer);
        snapshotTimer = null;
        // Best-effort flush before browser may freeze the tab.
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
      // sendBeacon survives the page teardown; sync supabase fetch may not.
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
      if (countTimer) window.clearTimeout(countTimer);
      if (indexTimer) window.clearTimeout(indexTimer);
      ytext.unobserve(scheduleCounts);
      
      unsubAwareness();
      unsubSync();
      idb?.destroy();
    };
  }, [slug, validSlug, doc, provider, embedSlug, encPhase, encTargetIsCurrent, encryption, encMeta.isEncrypted, encMeta.ydocState, encMeta.rowExists, capabilityAccess, capabilityToken]);

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
        <Button type="button" onClick={() => setMetaVersion((n) => n + 1)}>
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
          observedHashRef.current = window.location.hash;
          // replaceState() emits no browser navigation event. Notify every
          // other mounted gate (notably the sibling SplitView pane) after this
          // instance adopts the hash, so a key replaced elsewhere cannot
          // leave stale plaintext mounted.
          window.dispatchEvent(new Event("hashchange"));
          setEncryption({
            encrypt: (b) => encryptBytes(key, b),
            decrypt: (b) => decryptBytes(key, b),
          });
          setEncPhase("ready");
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

  // SplitView wraps each panel — render the workspace without the global topbar.
  // SplitView wraps each panel — render compact topbar + editor (+ preview if toggled).
  // Compact topbar hides app-wide toggles (zen, theme, settings) but keeps
  // per-note actions (preview toggle, lock, share, rename, status, presence).
  // The ready phase schedules resource acquisition in a layout effect. Keep
  // the workspace closed for that single commit until its owned pair exists.
  if (!doc || !provider) return null;
  const legacyContainment = legacyOnly || !capabilityAccess;
  const getContent = () => doc.getText("content").toString();
  const legacyEncryptionSecret = legacyContainment ? readEncryptionSecret(location.hash) : "";
  const currentShareUrl = legacyContainment && typeof window !== "undefined"
    ? `${window.location.origin}/${slug}${
      legacyEncryptionSecret ? `#${encodeURIComponent(legacyEncryptionSecret)}` : ""
    }`
    : undefined;

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
          isEncrypted={encMeta.isEncrypted}
          encryption={encryption}
          capabilityAccess={capabilityAccess}
          allowEncryptionTransitions={!legacyContainment}
          currentShareUrl={currentShareUrl}
          paginated={paginated}
          onTogglePagination={togglePagination}
          compact
          narrowOverride={narrow}
        />
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
                doc={doc}
                awareness={provider.awareness}
                className="h-full overflow-auto"
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
        isEncrypted={encMeta.isEncrypted}
        encryption={encryption}
        capabilityAccess={capabilityAccess}
        allowEncryptionTransitions={!legacyContainment}
        currentShareUrl={currentShareUrl}
        paginated={paginated}
        onTogglePagination={togglePagination}
        outlineOpen={outlineOpen}
        onToggleOutline={() => setOutlineOpen((open) => !open)}
        outlineTriggerRef={outlineTriggerRef}
      />

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
            <div className={showPreviewPane && !narrow ? "flex-1 min-h-0 min-w-0" : "flex-1 min-w-0"}>
              <Editor
                ref={editorRef}
                doc={doc}
                awareness={provider.awareness}
                editable={!writeFenced}
                className="h-full overflow-auto"
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
