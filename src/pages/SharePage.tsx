import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { Helmet } from "react-helmet-async";
import { ArrowLeft, Eye } from "lucide-react";
import * as Y from "yjs";
import { supabase } from "@/integrations/supabase/client";
import { Preview } from "@/components/note/Preview";
import { UnlockForm } from "@/components/note/UnlockForm";
import { EditorSkeleton } from "@/components/note/EditorSkeleton";
import { deriveKey, decryptBytes, verifyCheck, iterationsFor } from "@/lib/crypto";
import { base64ToBytes } from "@/lib/yjs/base64";
import { useI18n } from "@/i18n";
import { AppShell } from "@/components/app/AppShell";
import { useSceneTheme } from "@/hooks/use-scene-theme";
import type { NoteSession } from "@/lib/capability/client";
import { parseCapabilityLocation, readEncryptionSecret, type CapabilityAccess } from "@/lib/capability/url";
import type { Encryption } from "@/lib/yjs/provider";
import { parseLegacyShareFragment } from "@/lib/legacy/share-url";

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SHARE_CANONICAL_URL = "https://note.syrin.online/s";
const SHARE_ROBOTS = "noindex,nofollow,noarchive,nosnippet";

type ShareViewResponse = {
  content: string;
  ydoc_state: string;
  is_encrypted: boolean;
  enc_salt: string | null;
  enc_check: string | null;
  enc_iterations: number | null;
  updated_at: string;
};

type RequestTarget = {
  token: string;
  targetHash: string;
  generation: number;
};

type ViewState =
  | (RequestTarget & { kind: "loading" })
  | (RequestTarget & { kind: "notfound" })
  | (RequestTarget & { kind: "error"; message: string })
  | (RequestTarget & { kind: "ready"; doc: Y.Doc })
  | (RequestTarget & { kind: "needs-key"; salt: string; check: string; iterations: number; ydocState: string });

function hydrateDoc(ydocB64: string, fallbackText: string): Y.Doc {
  const doc = new Y.Doc();
  if (ydocB64) {
    try {
      Y.applyUpdate(doc, base64ToBytes(ydocB64));
      return doc;
    } catch (e) {
      console.warn("share: applyUpdate failed", e);
    }
  }
  // Notes sometimes have empty ydoc_state but non-empty content (legacy rows
  // or freshly-typed plaintext that hasn't been snapshotted yet). Seed the
  // yjs doc from the plain content column so the preview still renders.
  if (fallbackText) doc.getText("content").insert(0, fallbackText);
  return doc;
}

type CapabilityYjsProviderCtor = typeof import("@/lib/yjs/capability-provider").CapabilityYjsProvider;

const loadCapabilityApi = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true"
  ? async () => (await import("@/lib/capability/client")).createCapabilityApi()
  : async () => {
      throw new Error("capability API unavailable");
    };

const loadCapabilityYjsProvider = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true"
  ? async () => (await import("@/lib/yjs/capability-provider")).CapabilityYjsProvider
  : async () => {
      throw new Error("capability API unavailable");
    };

interface SharePageProps {
  /** Ignore capability-shaped fragments while the capability backend is offline. */
  legacyOnly?: boolean;
}

export default function SharePage({ legacyOnly = false }: SharePageProps) {
  const location = useLocation();
  const access = (() => {
    if (legacyOnly) return null;
    return typeof window === "undefined"
      ? null
      : parseCapabilityLocation(new URL(window.location.href));
  })();
  if (access?.scope === "view") {
    return <CapabilitySharePage key={`${access.token}:${location.hash}`} access={access} />;
  }
  return <LegacySharePage />;
}

function CapabilitySharePage({ access }: { access: CapabilityAccess }) {
  const { t } = useI18n();
  const tRef = useRef(t);
  const capabilityYjsProviderRef = useRef<CapabilityYjsProviderCtor | null>(null);
  const [session, setSession] = useState<NoteSession | null>(null);
  const [encryption, setEncryption] = useState<Encryption | null>(null);
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unlockRequired, setUnlockRequired] = useState(false);

  useLayoutEffect(() => { tRef.current = t; }, [t]);

  useEffect(() => {
    let cancelled = false;
    capabilityYjsProviderRef.current = null;
    setSession(null);
    setEncryption(null);
    setDoc(null);
    setError(null);
    setUnlockRequired(false);
    void (async () => {
      try {
        const [api, CapabilityYjsProvider] = await Promise.all([
          loadCapabilityApi(),
          loadCapabilityYjsProvider(),
        ]);
        if (cancelled) return;
        const opened = await api.openSession(access.token);
        if (cancelled) return;
        if (opened.scope !== "view") throw new Error("view capability required");
        capabilityYjsProviderRef.current = CapabilityYjsProvider;
        setSession(opened);
        if (!opened.encryption.enabled) return;
        if (!opened.encryption.salt || !opened.encryption.check) {
          throw new Error(tRef.current("share.missing_salt"));
        }
        const secret = readEncryptionSecret(window.location.hash);
        if (!secret) {
          setUnlockRequired(true);
          return;
        }
        const key = await deriveKey(secret, opened.encryption.salt, opened.encryption.iterations);
        if (cancelled) return;
        if (!(await verifyCheck(key, opened.encryption.check))) {
          setUnlockRequired(true);
          return;
        }
        if (cancelled) return;
        setEncryption({
          encrypt: (bytes) => import("@/lib/crypto").then(({ encryptBytes }) => encryptBytes(key, bytes)),
          decrypt: (bytes) => decryptBytes(key, bytes),
        });
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => { cancelled = true; };
  }, [access.token]);

  useEffect(() => {
    const CapabilityYjsProvider = capabilityYjsProviderRef.current;
    if (!session || !CapabilityYjsProvider || (session.encryption.enabled && !encryption)) return;
    let disposed = false;
    const ownedDoc = new Y.Doc();
    const provider = new CapabilityYjsProvider(access, session, ownedDoc, {}, encryption);
    provider.setExpectedEncrypted(session.encryption.enabled);
    void provider.connect({ name: "Viewer", color: "#64748b" }).then(() => {
      if (!disposed) setDoc(ownedDoc);
    }).catch((cause) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      disposed = true;
      setDoc(null);
      void provider.destroy().finally(() => ownedDoc.destroy());
    };
  }, [access, session, encryption]);

  const head = <ShareHead />;
  if (error) {
    return (
      <>{head}<main className="flex min-h-svh items-center justify-center px-4 text-sm text-destructive" role="alert">{error}</main></>
    );
  }
  if (session?.encryption.enabled && unlockRequired && !encryption) {
    return (
      <>
        {head}
        <main>
          <UnlockForm
            slug={t("share.slug_label")}
            salt={session.encryption.salt!}
            check={session.encryption.check!}
            iterations={session.encryption.iterations}
            onUnlock={(key) => {
              setEncryption({
                encrypt: (bytes) => import("@/lib/crypto").then(({ encryptBytes }) => encryptBytes(key, bytes)),
                decrypt: (bytes) => decryptBytes(key, bytes),
              });
              setUnlockRequired(false);
            }}
          />
        </main>
      </>
    );
  }
  if (!doc) return <>{head}<EditorSkeleton /></>;
  return <ShareReady head={head} doc={doc} t={t} />;
}

function ShareHead() {
  const { t } = useI18n();
  return (
    <Helmet>
      <title>Shared note — Syrin Notes</title>
      <meta name="description" content={t("share.readonly_desc")} />
      <link rel="canonical" href={SHARE_CANONICAL_URL} />
      <meta name="robots" content={SHARE_ROBOTS} />
      <meta name="googlebot" content={SHARE_ROBOTS} />
      <meta property="og:title" content={t("share.dialog_title")} />
      <meta property="og:description" content={t("share.readonly_desc")} />
      <meta property="og:url" content={SHARE_CANONICAL_URL} />
    </Helmet>
  );
}
function LegacySharePage() {
  const params = useParams();
  const location = useLocation();
  const legacyAccess = parseLegacyShareFragment(
    typeof window === "undefined" ? location.hash : window.location.hash,
  );
  // main.tsx rewrites the old path before BrowserRouter starts. The param
  // fallback keeps the compatibility shell robust under embedded/test mounts.
  const token = legacyAccess?.token ?? (TOKEN_RE.test(params.token ?? "") ? params.token! : "");
  const valid = TOKEN_RE.test(token);
  const [currentHash, setCurrentHash] = useState(
    () => window.location.hash,
  );
  const [externalHashRevision, setExternalHashRevision] = useState(0);
  const [state, setState] = useState<ViewState>(() => ({
    kind: "loading",
    token,
    targetHash: currentHash,
    generation: 0,
  }));
  const requestGeneration = useRef(0);
  const currentHashRef = useRef(currentHash);
  const committedTargetRef = useRef({ token, targetHash: currentHash });
  const routerTarget = `${location.key}\u0000${location.pathname}\u0000${location.search}\u0000${location.hash}`;
  const routerTargetRef = useRef(routerTarget);
  const { t } = useI18n();
  const translationRef = useRef(t);

  const observeExternalHash = useCallback((nextHash: string) => {
    if (currentHashRef.current === nextHash) return;
    currentHashRef.current = nextHash;
    setCurrentHash(nextHash);
    setExternalHashRevision((revision) => revision + 1);
  }, []);

  useLayoutEffect(() => {
    translationRef.current = t;
  }, [t]);

  useLayoutEffect(() => {
    const syncHash = () => observeExternalHash(window.location.hash);
    window.addEventListener("hashchange", syncHash);
    window.addEventListener("popstate", syncHash);
    // Close the commit-to-subscription race: reconcile any navigation that
    // happened after render but before these listeners were attached.
    syncHash();
    return () => {
      window.removeEventListener("hashchange", syncHash);
      window.removeEventListener("popstate", syncHash);
    };
  }, [observeExternalHash]);

  useLayoutEffect(() => {
    if (routerTargetRef.current === routerTarget) return;
    routerTargetRef.current = routerTarget;
    observeExternalHash(location.hash);
  }, [routerTarget, location.hash, observeExternalHash]);

  useLayoutEffect(() => {
    committedTargetRef.current = { token, targetHash: currentHash };
  }, [token, currentHash]);

  const isCurrentRequest = useCallback((
    generation: number,
    requestToken: string,
    requestHash: string,
  ) => {
    const committedTarget = committedTargetRef.current;
    return requestGeneration.current === generation
      && committedTarget.token === requestToken
      && committedTarget.targetHash === requestHash
      && window.location.hash === requestHash;
  }, []);

  useEffect(() => {
    document.title = `Syrin Notes — ${t("share.title_suffix")}`;
    return () => {
      document.title = "Syrin Notes";
    };
  }, [t]);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    const requestToken = token;
    const requestHash = currentHashRef.current;
    const requestTarget: RequestTarget = {
      token: requestToken,
      targetHash: requestHash,
      generation,
    };
    let cancelled = false;
    const isCurrent = () =>
      !cancelled && isCurrentRequest(generation, requestToken, requestHash);
    const cancel = () => {
      cancelled = true;
      if (requestGeneration.current === generation) {
        requestGeneration.current += 1;
      }
    };

    if (!valid) {
      setState({ kind: "notfound", ...requestTarget });
      return cancel;
    }
    setState({ kind: "loading", ...requestTarget });
    (async () => {
      const { data, error } = await supabase.functions.invoke<ShareViewResponse>(
        "share-view",
        { headers: { "x-legacy-share": requestToken } },
      );
      if (!isCurrent()) return;
      if (error || !data) {
        setState({ kind: "notfound", ...requestTarget });
        return;
      }

      if (!data.is_encrypted) {
        setState({
          kind: "ready",
          ...requestTarget,
          doc: hydrateDoc(data.ydoc_state, data.content),
        });
        return;
      }

      if (!data.enc_salt || !data.enc_check) {
        setState({
          kind: "error",
          ...requestTarget,
          message: translationRef.current("share.missing_salt"),
        });
        return;
      }

      // If a key is already in the URL hash (typical share-with-key flow),
      // try to unlock silently. On failure, drop through to the password form.
      const iterations = iterationsFor(data.enc_iterations);
      let hash = parseLegacyShareFragment(requestHash)?.encryptionSecret ?? "";
      if (!hash && !requestHash.includes("legacy=")) {
        try { hash = decodeURIComponent(requestHash.replace(/^#/, "")); } catch { /* manual unlock */ }
      }
      if (hash) {
        try {
          const key = await deriveKey(hash, data.enc_salt, iterations);
          if (!isCurrent()) return;
          const verified = await verifyCheck(key, data.enc_check);
          if (!isCurrent()) return;
          if (verified) {
            const pt = await decryptBytes(key, base64ToBytes(data.ydoc_state));
            if (!isCurrent()) return;
            const doc = new Y.Doc();
            Y.applyUpdate(doc, pt);
            setState({ kind: "ready", ...requestTarget, doc });
            return;
          }
        } catch (e) {
          if (!isCurrent()) return;
          console.warn("share: auto-decrypt failed", e);
        }
      }

      if (isCurrent()) {
        setState({
          kind: "needs-key",
          ...requestTarget,
          salt: data.enc_salt,
          check: data.enc_check,
          iterations,
          ydocState: data.ydoc_state,
        });
      }
    })();
    return cancel;
  }, [token, valid, externalHashRevision, isCurrentRequest]);

  const onUnlock = async (key: CryptoKey) => {
    if (state.kind !== "needs-key") return;
    const lockedState = state;
    const generation = lockedState.generation;
    const requestToken = lockedState.token;
    const requestHash = window.location.hash;
    const isCurrentManualRequest = () => {
      const committedTarget = committedTargetRef.current;
      return requestGeneration.current === generation
        && committedTarget.token === requestToken
        && committedTarget.targetHash === lockedState.targetHash
        && window.location.hash === requestHash;
    };
    if (!isCurrentManualRequest()) return;
    try {
      const pt = await decryptBytes(key, base64ToBytes(lockedState.ydocState));
      if (!isCurrentManualRequest()) return;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, pt);
      currentHashRef.current = requestHash;
      setCurrentHash(requestHash);
      setState({
        kind: "ready",
        token: requestToken,
        targetHash: requestHash,
        generation,
        doc,
      });
    } catch (e) {
      if (!isCurrentManualRequest()) return;
      console.error("share: manual decrypt failed", e);
      currentHashRef.current = requestHash;
      setCurrentHash(requestHash);
      setState({
        kind: "error",
        token: requestToken,
        targetHash: requestHash,
        generation,
        message: translationRef.current("share.decrypt_failed"),
      });
    }
  };

  const head = (
    <Helmet>
      <title>Shared note — Syrin Notes</title>
      {/* eslint-disable no-restricted-syntax -- crawler-facing SEO copy (page is noindex) */}
      <meta name="description" content="View a shared markdown note in read-only mode on Syrin Notes. Private link, revocable anytime." />
      <link rel="canonical" href={SHARE_CANONICAL_URL} />
      <meta name="robots" content={SHARE_ROBOTS} />
      <meta name="googlebot" content={SHARE_ROBOTS} />
      <meta property="og:title" content="Shared note — Syrin Notes" />
      <meta property="og:description" content="A markdown note shared in read-only mode. Private link, revocable." />
      <meta property="og:url" content={SHARE_CANONICAL_URL} />
      <meta name="twitter:title" content="Shared note — Syrin Notes" />
      <meta name="twitter:description" content="A markdown note shared in read-only mode." />
      {/* eslint-enable no-restricted-syntax */}
    </Helmet>
  );

  if (
    state.token !== token || state.targetHash !== currentHash
    || state.kind === "loading"
  ) {
    return <>{head}<EditorSkeleton /></>;
  }

  if (state.kind === "notfound") {
    return (
      <>
        {head}
        <main className="flex min-h-svh flex-col items-center justify-center gap-3 bg-background px-4 text-center">
          <p className="text-sm text-muted-foreground" role="alert">{t("share.notfound")}</p>
          <Link to="/" className="text-sm text-primary hover:underline">{t("share.back_home")}</Link>
        </main>
      </>
    );
  }

  if (state.kind === "error") {
    return (
      <>
        {head}
        <main className="flex min-h-svh flex-col items-center justify-center gap-3 bg-background px-4 text-center">
          <p className="text-sm text-destructive" role="alert">{state.message}</p>
          <Link to="/" className="text-sm text-primary hover:underline">{t("share.back_home")}</Link>
        </main>
      </>
    );
  }

  if (state.kind === "needs-key") {
    return (
      <>
        {head}
        <main>
          <UnlockForm
            slug={t("share.slug_label")}
            salt={state.salt}
            check={state.check}
            iterations={state.iterations}
            onUnlock={onUnlock}
          />
        </main>
      </>
    );
  }

  return <ShareReady head={head} doc={state.doc} t={t} />;
}

function ShareReady({ head, doc, t }: { head: React.ReactNode; doc: Y.Doc; t: ReturnType<typeof useI18n>["t"] }) {
  const { scene } = useSceneTheme();
  const hasScene = scene !== "none";
  return (
    <>
      {head}
      <AppShell className="flex min-h-svh flex-col">
        <header
          data-scene-chrome
          className={
            "sticky top-0 z-30 flex h-11 items-center gap-2 border-b px-3 text-sm " +
            (hasScene
              ? "motion-safe:backdrop-blur-md"
              : "border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80")
          }
          style={
            hasScene
              ? { background: "var(--home-chrome-bg)", borderColor: "var(--home-chrome-border)" }
              : undefined
          }
        >
          <Link to="/" className="text-muted-foreground hover:text-foreground" aria-label={t("share.back_home_aria")}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <Eye className="h-4 w-4 text-muted-foreground" />
          <span className="font-mono text-xs text-muted-foreground">{t("share.read_only")}</span>
        </header>
        <main className="flex-1 overflow-auto bg-muted/30">
          <Preview doc={doc} />
        </main>
      </AppShell>
    </>
  );
}
