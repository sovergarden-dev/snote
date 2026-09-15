import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Eye, Loader2 } from "lucide-react";
import { Helmet } from "react-helmet-async";
import { Link, Navigate, useNavigate } from "react-router";
import * as Y from "yjs";
import { AppShell } from "@/components/app/AppShell";
import { Preview } from "@/components/note/Preview";
import { UnlockForm } from "@/components/note/UnlockForm";
import { LegacyRoBanner, NoteSecurityPanel } from "@/components/note/NoteSecurityPanel";
import { toast } from "@/hooks/use-toast";
import { deriveKey, decryptBytes, encryptBytes, iterationsFor, verifyCheck } from "@/lib/crypto";
import type { DuplicateFailureKind, LegacyNote } from "@/lib/legacy/cutover";
import { isUsableSlug } from "@/lib/slug";
import { base64ToBytes } from "@/lib/yjs/base64";
import type { Encryption } from "@/lib/yjs/provider";
import { useI18n, type TKey } from "@/i18n";

const PRIVATE_PAGE_ROBOTS = "noindex,nofollow,noarchive,nosnippet";

const loadLegacyCutover = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true"
  ? () => import("@/lib/legacy/cutover")
  : async () => {
      throw new Error("legacy note API unavailable");
    };

const loadCapabilityApi = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true"
  ? async () => (await import("@/lib/capability/client")).createCapabilityApi()
  : async () => {
      throw new Error("capability API unavailable");
    };

type ReadyState = {
  kind: "ready";
  note: LegacyNote;
  doc: Y.Doc;
  encryption: Encryption | null;
  encryptionSecret: string;
};

type State =
  | { kind: "loading" }
  | { kind: "notfound" }
  | { kind: "error"; message: string }
  | { kind: "needs-key"; note: LegacyNote }
  | ReadyState;

function duplicateFailKey(kind: DuplicateFailureKind): TKey {
  if (kind === "permission") return "security.duplicate_fail_permission";
  return "security.duplicate_fail";
}

function hydratePlaintext(note: LegacyNote) {
  const doc = new Y.Doc();
  if (note.ydocState) {
    try {
      Y.applyUpdate(doc, base64ToBytes(note.ydocState));
      return doc;
    } catch {
      // Old rows may contain a stale snapshot; the plain content is the safe
      // read-only fallback and is copied only after explicit user action.
    }
  }
  if (note.content) doc.getText("content").insert(0, note.content);
  return doc;
}

async function unlockLegacy(note: LegacyNote, key: CryptoKey, secret: string): Promise<ReadyState> {
  const plaintext = await decryptBytes(key, base64ToBytes(note.ydocState));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, plaintext);
  return {
    kind: "ready",
    note,
    doc,
    encryption: {
      encrypt: (bytes) => encryptBytes(key, bytes),
      decrypt: (bytes) => decryptBytes(key, bytes),
    },
    encryptionSecret: secret,
  };
}

export default function LegacyNotePage({
  slug,
  embed = false,
  onPrimaryScroller,
}: {
  slug: string;
  embed?: boolean;
  onPrimaryScroller?: (element: HTMLElement | null) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [securityOpen, setSecurityOpen] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [duplicateFeedback, setDuplicateFeedback] = useState<
    "network" | "permission" | "retry" | "success" | null
  >(null);
  const duplicatingRef = useRef(false);
  const valid = isUsableSlug(slug);

  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    let ownedDoc: Y.Doc | null = null;
    setState({ kind: "loading" });
    setDuplicateFeedback(null);
    setDuplicating(false);
    duplicatingRef.current = false;
    void loadLegacyCutover().then(({ createLegacyNoteApi }) => {
      if (controller.signal.aborted) return;
      return createLegacyNoteApi().open(slug, controller.signal);
    }).then(async (note) => {
      if (controller.signal.aborted) return;
      if (!note) {
        setState({ kind: "notfound" });
        return;
      }
      if (!note.isEncrypted) {
        ownedDoc = hydratePlaintext(note);
        setState({ kind: "ready", note, doc: ownedDoc, encryption: null, encryptionSecret: "" });
        return;
      }
      const rawHash = window.location.hash.slice(1);
      let secret = "";
      try { secret = decodeURIComponent(rawHash); } catch { /* manual unlock */ }
      if (!secret || !note.salt || !note.check) {
        setState({ kind: "needs-key", note });
        return;
      }
      try {
        const key = await deriveKey(secret, note.salt, iterationsFor(note.iterations));
        if (controller.signal.aborted) return;
        if (!(await verifyCheck(key, note.check))) {
          setState({ kind: "needs-key", note });
          return;
        }
        const ready = await unlockLegacy(note, key, secret);
        if (controller.signal.aborted) {
          ready.doc.destroy();
          return;
        }
        ownedDoc = ready.doc;
        setState(ready);
      } catch {
        if (!controller.signal.aborted) setState({ kind: "needs-key", note });
      }
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => {
      controller.abort();
      ownedDoc?.destroy();
    };
  }, [slug, valid]);

  const onDuplicateSecurely = async () => {
    if (state.kind !== "ready" || duplicatingRef.current) return;
    const ready = state;
    duplicatingRef.current = true;
    setDuplicateFeedback(null);
    setDuplicating(true);
    try {
      const cutover = await loadLegacyCutover();
      const api = await loadCapabilityApi();
      const run = (targetSlug: string) => cutover.duplicateLegacyNote({
        api,
        source: ready.note,
        doc: ready.doc,
        targetSlug,
        encryption: ready.encryption,
        encryptionSecret: ready.encryptionSecret,
      });
      let url: string;
      try {
        url = await run(cutover.allocateDuplicateSlug());
      } catch (error) {
        if (cutover.mapDuplicateFailure(error) !== "slug_unavailable") throw error;
        url = await run(cutover.allocateDuplicateSlug());
      }
      toast({ title: t("security.duplicate_success") });
      setDuplicateFeedback("success");
      setDuplicating(false);
      const next = new URL(url);
      navigate(`${next.pathname}${next.hash}`);
    } catch (error) {
      const kind = await loadLegacyCutover()
        .then((cutover) => cutover.mapDuplicateFailure(error))
        .catch((): DuplicateFailureKind => "network");
      const feedback = kind === "permission" || kind === "network" ? kind : "retry";
      setDuplicateFeedback(feedback);
      toast({ title: t(duplicateFailKey(kind)), variant: "destructive" });
      duplicatingRef.current = false;
      setDuplicating(false);
    }
  };

  if (!valid) return <Navigate to="/" replace />;

  const head = (
    <Helmet>
      <title>{t("legacy.title")}</title>
      <link rel="canonical" href="https://note.syrin.online/" />
      <meta name="robots" content={PRIVATE_PAGE_ROBOTS} />
      <meta name="googlebot" content={PRIVATE_PAGE_ROBOTS} />
    </Helmet>
  );

  const security = (
    <NoteSecurityPanel
      slug={slug}
      doc={state.kind === "ready" ? state.doc : null}
      isEncrypted={state.kind === "ready" || state.kind === "needs-key" ? state.note.isEncrypted : false}
      allowEncryptionTransitions={false}
      legacyOn
      hideEncrypt
      open={securityOpen}
      onOpenChange={setSecurityOpen}
      onDuplicateSecurely={state.kind === "ready" ? onDuplicateSecurely : undefined}
      duplicateBusy={duplicating}
      duplicateFeedback={duplicateFeedback}
    />
  );

  if (state.kind === "loading") {
    return <>{head}<div className={`flex h-full items-center justify-center ${embed ? "min-h-0" : "min-h-svh"}`} role="status" aria-label={t("common.loading")}><Loader2 className="h-5 w-5 motion-safe:animate-spin" aria-hidden="true" /></div></>;
  }
  if (state.kind === "notfound" || state.kind === "error") {
    return (
      <>
        {head}
        <div className="flex min-h-svh flex-col">
          <div className="flex min-h-11 items-center justify-end border-b px-3 py-1">{security}</div>
          <LegacyRoBanner />
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
            <p className="text-sm text-muted-foreground">
              {state.kind === "notfound" ? t("legacy.not_found") : t("legacy.unavailable")}
            </p>
            <Link to="/" className="text-sm text-primary hover:underline">{t("share.back_home")}</Link>
          </div>
        </div>
      </>
    );
  }

  if (state.kind === "needs-key") {
    return (
      <>{head}
        <div className="flex min-h-11 items-center justify-end px-3 py-1">{security}</div>
        <LegacyRoBanner />
        <UnlockForm
        slug={slug}
        salt={state.note.salt!}
        check={state.note.check!}
        iterations={iterationsFor(state.note.iterations)}
        embedded={embed}
        onUnlock={(key) => {
          const secret = (() => {
            try { return decodeURIComponent(window.location.hash.slice(1)); } catch { return ""; }
          })();
          void unlockLegacy(state.note, key, secret).then(setState).catch(() => {
            setState({ kind: "error", message: "decrypt failed" });
          });
        }}
      /></>
    );
  }

  const content = (
    <>
      {head}
      <header className="flex min-h-12 flex-wrap items-center gap-2 border-b bg-background px-3 py-2">
        {!embed && <Link to="/" aria-label={t("share.back_home_aria")}><ArrowLeft className="h-4 w-4" /></Link>}
        <Eye className="h-4 w-4 text-muted-foreground" />
        <span className="mr-auto text-xs font-medium text-muted-foreground">{t("legacy.read_only")}</span>
        {security}
      </header>
      <LegacyRoBanner />
      <main
        ref={onPrimaryScroller}
        className="min-h-0 flex-1 overflow-auto bg-muted/30"
      >
        <Preview doc={state.doc} slug={slug} />
      </main>
    </>
  );

  return embed
    ? <div className="flex h-full min-h-0 flex-col">{content}</div>
    : <AppShell className="flex h-svh flex-col">{content}</AppShell>;
}
