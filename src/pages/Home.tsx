import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Check, Loader2, Shuffle, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SceneToggle } from "@/components/SceneToggle";
import { LanguageToggle } from "@/components/LanguageToggle";
import { getPinned, getRecents, removeRecent, togglePin, type RecentNote } from "@/lib/recent-notes";
import { InstallPrompt } from "@/components/note/InstallPrompt";
import { isExtensionContext } from "@/lib/ext-context";
import { useI18n, type TKey } from "@/i18n";
import { useSceneTheme } from "@/hooks/use-scene-theme";
import { useIsMobile } from "@/hooks/use-mobile";
import { SCENE_NONE } from "@/components/home/scenes/registry";
import { formatModShortcut } from "@/lib/shortcut-hint";
import { cn } from "@/lib/utils";
import SceneHost from "@/components/home/SceneHost";
import { softNavigate } from "@/lib/soft-navigate";
import { isUsableSlug } from "@/lib/slug";
import {
  clearPendingOwnerCandidate,
  mapMintFailure,
  mintCapabilityNote,
} from "@/lib/capability/owner-candidate";

const HomeTemplatePicker = lazy(() => import("@/components/home/HomeTemplatePicker"));
const HomeLibraryPanel = lazy(() => import("@/components/home/HomeLibraryPanel"));

type SlugStatus = "idle" | "checking" | "available" | "taken" | "invalid";

const loadCapabilityApi = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true"
  ? async () => (await import("@/lib/capability/client")).createCapabilityApi()
  : null;

const loadLegacyNoteApi = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true"
  ? async () => (await import("@/lib/legacy/cutover")).createLegacyNoteApi()
  : null;

function mintErrorKey(kind: ReturnType<typeof mapMintFailure>["kind"]): TKey {
  if (kind === "slug_unavailable") return "home.error.slug_unavailable";
  if (kind === "rate_limited") return "home.error.create_rate_limited";
  if (kind === "unavailable") return "home.error.create_unavailable";
  return "home.error.create_failed";
}

function randomSlug() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function useTimeAgo() {
  const { t } = useI18n();
  return (ts: number) => {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return t("time.just_now");
    if (m < 60) return t("time.minutes_ago", { n: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t("time.hours_ago", { n: h });
    const d = Math.floor(h / 24);
    return t("time.days_ago", { n: d });
  };
}

// Idle prefetch helper.
function onIdle(cb: () => void) {
  if (typeof window === "undefined") return;
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (ric) ric(cb);
  else window.setTimeout(cb, 200);
}

// Heavy editor modules — warmed only when intent is signaled (slug input,
// hovering a recent) AND the device looks capable. Idempotent.
let editorWarmed = false;
function prefetchEditor() {
  if (editorWarmed) return;
  editorWarmed = true;
  void import("@/pages/NotePage");
  void import("yjs");
  void import("y-indexeddb");
  void import("y-codemirror.next");
  void import("@codemirror/lang-markdown");
  void import("marked");
  void import("dompurify");
}

function canPrefetchEditor(isMobile: boolean): boolean {
  if (isMobile) return false;
  if (typeof navigator === "undefined") return false;
  const conn = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData) return false;
  if (conn?.effectiveType && ["2g", "slow-2g", "3g"].includes(conn.effectiveType)) return false;
  const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  if (mem < 4) return false;
  return true;
}

export default function Home() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const timeAgo = useTimeAgo();
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentNote[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState("blank");
  const [libraryLists, setLibraryLists] = useState<{
    pinned: string[];
    recents: RecentNote[];
  } | null>(null);
  const [slugStatus, setSlugStatus] = useState<SlugStatus>("idle");
  const [checkNonce, setCheckNonce] = useState(0);
  const [creating, setCreating] = useState(false);
  const pendingCreateRef = useRef<string | null>(null);
  const isMobile = useIsMobile();
  const { scene, committedScene, setScene } = useSceneTheme();

  // Mobile: scenes are heavyweight WebGL/Canvas backgrounds that don't add
  // value on small screens. Clear any persisted scene from a desktop session
  // so SceneHost stays unmounted and zero GPU is allocated.
  useEffect(() => {
    if (isMobile && committedScene !== SCENE_NONE) setScene(SCENE_NONE);
  }, [isMobile, committedScene, setScene]);

  useEffect(() => {
    setRecents(getRecents());
    setPinned(getPinned());
  }, []);

  // Stay in sync with pins toggled elsewhere (NotePage's PinButton, Cmd+K).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "note.pinned") setPinned(getPinned());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Debounced availability check. Canary-on uses LNO exists (no char_count:
  // exists:true includes empty legacy rows and is treated as taken). Canary-off
  // skips the lookup; Open still seedAndOpen.
  useEffect(() => {
    const trimmed = slug.trim();
    if (!trimmed) {
      setSlugStatus("idle");
      return;
    }
    if (!isUsableSlug(trimmed)) {
      setSlugStatus("invalid");
      return;
    }
    const canaryOn = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true";
    if (!canaryOn || !loadLegacyNoteApi) {
      setSlugStatus("idle");
      return;
    }
    setSlugStatus("checking");
    const ctrl = new AbortController();
    const delay = pendingCreateRef.current === trimmed ? 0 : 350;
    const t = window.setTimeout(async () => {
      try {
        const api = await loadLegacyNoteApi();
        if (ctrl.signal.aborted) return;
        const exists = await api.exists(trimmed, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setSlugStatus(exists ? "taken" : "available");
      } catch {
        if (ctrl.signal.aborted) return;
        setSlugStatus("idle");
      }
    }, delay);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [slug, checkNonce]);

  // Warm up heavy editor modules ONLY when the device looks capable. On
  // mobile / save-data / low-memory devices, skip — keeps the Home heap
  // small across F5s and the user only pays when they actually open a note.
  // Even on capable devices, defer 8s so first paint stays fast.
  useEffect(() => {
    if (!canPrefetchEditor(isMobile)) return;
    const id = window.setTimeout(() => onIdle(prefetchEditor), 8000);
    return () => window.clearTimeout(id);
  }, [isMobile]);

  const seedAndOpen = (s: string) => {
    const go = () => softNavigate(navigate, `/${s}`);
    if (templateId === "blank") {
      go();
      return;
    }
    void import("@/lib/note-templates").then((mod) => {
      mod.queueTemplateSeed(s, mod.resolveTemplateMarkdown(templateId, t));
      go();
    });
  };

  const queueTemplateIfNeeded = async (s: string) => {
    if (templateId === "blank") return;
    const mod = await import("@/lib/note-templates");
    mod.queueTemplateSeed(s, mod.resolveTemplateMarkdown(templateId, t));
  };

  const mintAndOpen = async (s: string) => {
    if (!loadCapabilityApi) return;
    setError(null);
    setCreating(true);
    try {
      const api = await loadCapabilityApi();
      const minted = await mintCapabilityNote(s, (slug, owner) => api.createNote(slug, owner));
      await queueTemplateIfNeeded(s);
      await softNavigate(navigate, minted.path);
      clearPendingOwnerCandidate(s);
    } catch (error) {
      const failure = mapMintFailure(error);
      if (failure.kind === "slug_unavailable") clearPendingOwnerCandidate(s);
      setError(t(mintErrorKey(failure.kind)));
    } finally {
      setCreating(false);
    }
  };

  const openAfterStatusRef = useRef<(trimmed: string, status: SlugStatus) => void>(() => {});
  openAfterStatusRef.current = (trimmed, status) => {
    const canaryOn = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true";
    if (status === "invalid") {
      setError(t("home.error.invalid_slug"));
      return;
    }
    if (canaryOn && loadCapabilityApi) {
      if (status === "available") {
        void mintAndOpen(trimmed);
        return;
      }
      if (status === "taken") {
        seedAndOpen(trimmed);
        return;
      }
      setError(t("home.error.create_unavailable"));
      return;
    }
    seedAndOpen(trimmed);
  };

  useEffect(() => {
    const pending = pendingCreateRef.current;
    if (!pending) return;
    if (slug.trim() !== pending) {
      pendingCreateRef.current = null;
      return;
    }
    if (slugStatus === "checking") return;
    pendingCreateRef.current = null;
    openAfterStatusRef.current(pending, slugStatus);
  }, [slug, slugStatus]);

  const open = (s: string) => {
    const trimmed = s.trim();
    if (!isUsableSlug(trimmed)) {
      setError(t("home.error.invalid_slug"));
      return;
    }
    setError(null);
    const canaryOn = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true";
    if (!canaryOn || !loadCapabilityApi) {
      seedAndOpen(trimmed);
      return;
    }
    if (slugStatus === "checking") {
      pendingCreateRef.current = trimmed;
      return;
    }
    if (slugStatus === "idle") {
      pendingCreateRef.current = trimmed;
      setSlugStatus("checking");
      setCheckNonce((n) => n + 1);
      return;
    }
    openAfterStatusRef.current(trimmed, slugStatus);
  };

  const hasLibrary = recents.length > 0 || pinned.length > 0;
  const visiblePinned = hasLibrary && libraryLists ? libraryLists.pinned : pinned;
  const visibleRecents = hasLibrary && libraryLists ? libraryLists.recents : recents.slice(0, 12);

  // Warm editor code on explicit hover/touch intent. Note content is not read
  // or cached from Home; the encryption gate owns every content load.
  const prefetchSnapshot = (s: string) => {
    // Hover/touch on a recent = clear signal the user is about to open a note.
    // Warm the editor modules now (idempotent).
    if (canPrefetchEditor(isMobile)) prefetchEditor();
    void s;
  };

  const hasScene = scene !== "none";
  // Legacy attribute kept for backward-compat with the i18n test + isolation
  // script; new code should branch on `data-scene` instead.
  const isCyber = scene === "cyber-linh-khi";
  const motionSafe = "motion-safe:transition motion-safe:duration-150";

  // Per-scene tokens come from index.css via [data-app-root][data-scene=...].
  // Default scene === "none" branch keeps its plain Tailwind classes so the
  // pristine light/dark layout stays byte-identical when no scene is active.
  const monoStyle = hasScene ? { fontFamily: "var(--home-mono-family)" } : undefined;

  return (
    <div
      data-scene={hasScene ? scene : undefined}
      data-theme={isCyber ? "cyber" : undefined}
      data-app-root="true"
      className={`relative isolate min-h-svh ${hasScene ? "bg-transparent" : "bg-background"}`}
    >
      {hasScene && <SceneHost />}
      <a
        href="#home-slug"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:border focus:border-border focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-md"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("home-slug")?.focus();
        }}
      >
        {t("home.skip_to_slug")}
      </a>
      <header
        className={cn(
          "relative z-10 flex h-12 items-center justify-between border-b px-4 motion-reduce:transition-none",
          hasScene
            ? "motion-safe:backdrop-blur-md"
            : "border-border/60 bg-background/80 supports-[backdrop-filter]:bg-background/60 motion-safe:backdrop-blur",
        )}
        style={
          hasScene
            ? { background: "var(--home-chrome-bg)", borderColor: "var(--home-chrome-border)" }
            : undefined
        }
      >
        <div className="flex items-center gap-2">
          <img src="/logo.webp" alt="Syrin Notes logo" width="24" height="24" decoding="async" className="h-6 w-6 rounded-md object-contain" />
          <span className="font-semibold tracking-tight">Syrin Notes</span>
        </div>
        <div className="flex items-center gap-1">
          {!isMobile && (
            <span className="hidden md:inline-flex">
              <SceneToggle />
            </span>
          )}
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-xl px-4 py-12 md:py-20">
        <h1
          className="bg-clip-text text-3xl font-semibold tracking-tight text-transparent md:text-4xl motion-safe:animate-[fade-in_500ms_ease-out] motion-reduce:animate-none"
          style={
            hasScene
              ? { backgroundImage: "var(--home-title-grad)" }
              : { backgroundImage: "linear-gradient(135deg, hsl(var(--foreground)), hsl(var(--foreground) / 0.6))" }
          }
        >
          {t("home.tagline")}
        </h1>
        <p className="mt-3 text-muted-foreground motion-safe:animate-[fade-in_500ms_ease-out_80ms_both] motion-reduce:animate-none">
          {t("home.intro_prefix")}
          <code className="rounded bg-muted px-1.5 py-0.5 text-sm text-foreground">/hello</code>
          {t("home.intro_suffix")}
        </p>

        <form
          className="mt-8 flex gap-2 motion-safe:animate-[fade-in_500ms_ease-out_160ms_both] motion-reduce:animate-none"
          onSubmit={(e) => {
            e.preventDefault();
            open(slug);
          }}
        >
          <div
            className={cn(
              "relative flex flex-1 items-center rounded-md border bg-transparent outline-none",
              motionSafe,
              "focus-within:ring-1 focus-within:ring-inset",
              !hasScene && "border-input/70 focus-within:border-ring/70 focus-within:ring-ring/35",
            )}
            style={
              hasScene
                ? ({
                    borderColor: "var(--home-input-border)",
                    // `--tw-ring-color` is what `focus-within:ring-*` reads.
                    ["--tw-ring-color" as string]: "var(--home-input-focus-ring)",
                  } as React.CSSProperties)
                : undefined
            }
          >
            <label htmlFor="home-slug" className="sr-only">
              {t("home.placeholder")}
            </label>
            <span className="pl-3 text-sm text-muted-foreground select-none">/</span>
            <Input
              id="home-slug"
              autoFocus
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setError(null);
              }}
              placeholder={t("home.placeholder")}
              className="h-10 border-0 bg-transparent px-1 font-mono shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              maxLength={64}
              aria-invalid={!!error || slugStatus === "invalid"}
              aria-describedby={`home-slug-status${error ? " home-slug-error" : ""}`}
            />
            <div
              id="home-slug-status"
              key={slugStatus}
              className="shrink-0 whitespace-nowrap pr-2 text-muted-foreground motion-safe:animate-slug-status-pop"
              role="status"
              aria-live="polite"
            >
              {slugStatus === "checking" && (
                <>
                  <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
                  <span className="sr-only">{t("home.status.checking")}</span>
                </>
              )}
              {slugStatus === "available" && (
                <>
                  <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                  <span className="sr-only">{t("home.status.available")}</span>
                </>
              )}
              {slugStatus === "taken" && (
                <span className="text-xs font-medium text-foreground">{t("home.status.taken")}</span>
              )}
              {slugStatus === "invalid" && (
                <span className="text-[10px] font-medium text-destructive">{t("home.status.invalid")}</span>
              )}
            </div>
          </div>
          <Button
            type="submit"
            disabled={!slug.trim() || creating}
          >
            {slugStatus === "taken" ? t("home.btn.open_existing") : t("home.btn.open")}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </form>
        {error && (
          <p id="home-slug-error" className="mt-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={creating}
            onClick={() => {
              const generated = randomSlug();
              if (import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true" && loadCapabilityApi) {
                void mintAndOpen(generated);
                return;
              }
              seedAndOpen(generated);
            }}
          >
            <Shuffle className="h-3.5 w-3.5" />
            {t("home.btn.random")}
          </Button>
          {/* Sized fallback: a null slot lets the picker pop in above
              InstallPrompt and swallow the first click (firefox BIP). */}
          <Suspense
            fallback={
              <span
                className="inline-block h-8 min-w-0 sm:min-w-[22rem]"
                aria-hidden="true"
              />
            }
          >
            <HomeTemplatePicker value={templateId} onChange={setTemplateId} />
          </Suspense>
          <span className="text-[11px] text-muted-foreground">
            {t("home.cmdk_hint_prefix")}<kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">{formatModShortcut(["K"])}</kbd>
            {" / "}
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">{formatModShortcut(["P"])}</kbd>{t("home.cmdk_hint_suffix")}
          </span>
        </div>

        {!isExtensionContext && <InstallPrompt />}

        {hasLibrary && (
          <Suspense fallback={null}>
            <HomeLibraryPanel
              recents={recents}
              pinned={pinned}
              onListsChange={setLibraryLists}
            />
          </Suspense>
        )}

        {visiblePinned.length > 0 && (
          <section
            className="sticky top-0 z-10 mt-10 -mx-4 bg-background/95 px-4 pb-3 pt-3 supports-[backdrop-filter]:bg-background/80 motion-safe:backdrop-blur"
            aria-label={t("home.pinned.aria")}
          >
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Star className="h-3 w-3 fill-primary text-primary" />
              {t("home.pinned.title")}
            </h2>
            <ul className="flex flex-wrap gap-1.5">
              {visiblePinned.map((s) => (
                <li
                  key={s}
                  className="group flex items-stretch overflow-hidden rounded-md border border-border bg-background motion-safe:transition motion-safe:duration-150 motion-safe:hover:-translate-y-px motion-safe:hover:border-foreground/20 motion-safe:hover:shadow-sm"
                >
                  <button
                    className="flex items-center gap-1.5 px-2.5 py-1 font-mono text-sm motion-safe:hover:bg-accent"
                    onClick={() => softNavigate(navigate, `/${s}`)}
                    onMouseEnter={() => prefetchSnapshot(s)}
                    onTouchStart={() => prefetchSnapshot(s)}
                  >
                    <Star className="h-3 w-3 fill-primary text-primary" />
                    /{s}
                  </button>
                  <button
                    aria-label={t("home.pinned.unpin")}
                    title={t("home.pinned.unpin")}
                    onClick={() => setPinned(togglePin(s))}
                    className="flex items-center px-1.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 motion-safe:transition-opacity hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {visibleRecents.length > 0 ? (
          <section className="mt-12">
            <h2
              className="mb-3 text-xs font-medium uppercase tracking-wider"
              style={
                hasScene
                  ? { color: "var(--home-section-label)", fontFamily: "var(--home-mono-family)" }
                  : { color: "hsl(var(--muted-foreground))" }
              }
            >
              {t("home.recent.title")}
            </h2>
            <ul
              className={cn(
                "divide-y rounded-md border",
                hasScene && "motion-safe:backdrop-blur-md",
              )}
              style={
                hasScene
                  ? {
                      background: "var(--home-recents-bg)",
                      borderColor: "var(--home-recents-border)",
                      // `divide-*` uses `--tw-divide-opacity` + currentColor on
                      // the border, so set the explicit color via style instead.
                      ["--home-recents-divider-var" as string]: "var(--home-recents-divider)",
                    } as React.CSSProperties
                  : undefined
              }
            >
              {visibleRecents.map((r) => (
                <li
                  key={r.slug}
                  className={cn(
                    "group flex items-center gap-2 px-3 py-2",
                    "motion-safe:transition-colors",
                    hasScene
                      ? "motion-safe:hover:ring-1 motion-safe:hover:ring-inset"
                      : "motion-safe:hover:bg-accent/50",
                  )}
                  style={
                    hasScene
                      ? ({
                          borderTopColor: "var(--home-recents-divider)",
                        } as React.CSSProperties)
                      : undefined
                  }
                  onMouseEnter={(e) => {
                    if (hasScene) {
                      e.currentTarget.style.backgroundColor = "var(--home-row-hover-bg)";
                      e.currentTarget.style.boxShadow = "inset 0 0 0 1px var(--home-row-hover-ring)";
                    }
                    prefetchSnapshot(r.slug);
                  }}
                  onMouseLeave={(e) => {
                    if (hasScene) {
                      e.currentTarget.style.backgroundColor = "";
                      e.currentTarget.style.boxShadow = "";
                    }
                  }}
                  onTouchStart={() => prefetchSnapshot(r.slug)}
                >
                  <button
                    className="flex flex-1 items-center justify-between text-left"
                    onClick={() => softNavigate(navigate, `/${r.slug}`)}
                  >
                    <span
                      className="font-mono text-sm"
                      style={hasScene ? { color: "var(--home-slug-color)", fontFamily: "var(--home-mono-family)" } : undefined}
                    >
                      /{r.slug}
                    </span>
                    <span
                      className="text-xs"
                      style={
                        hasScene
                          ? { color: "var(--home-slug-time-color)", fontFamily: "var(--home-mono-family)" }
                          : { color: "hsl(var(--muted-foreground))" }
                      }
                    >
                      {timeAgo(r.lastOpenedAt)}
                    </span>
                  </button>
                  <button
                    aria-label={t("home.recent.remove")}
                    onClick={() => setRecents(removeRecent(r.slug))}
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 motion-safe:transition-opacity hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {t("home.recent.local_only")}
            </p>
          </section>
        ) : recents.length === 0 ? (
          <section className="mt-12 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-8 text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-background ring-1 ring-border">
              {/* Custom hand-drawn notebook+pen mark — gentler than the
                  generic Sparkles icon for an empty-state. */}
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-5 w-5 text-muted-foreground"
                aria-hidden="true"
              >
                <path d="M6 4h9a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6z" />
                <path d="M6 4v16" opacity="0.5" />
                <path d="M9 8h5M9 12h5M9 16h3" opacity="0.6" />
                <path d="M16.5 3.5l3 3-6 6H10.5v-3z" />
              </svg>
            </div>
            <p className="text-sm font-medium">{t("home.empty.title")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("home.empty.hint")}
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {["scratch", "todo", "ideas", "journal"].map((s) => (
                <button
                  key={s}
                  onClick={() => softNavigate(navigate, `/${s}`)}
                  onMouseEnter={() => prefetchSnapshot(s)}
                  className="rounded-md border border-border bg-background px-2.5 py-1 font-mono text-xs text-foreground motion-safe:transition motion-safe:hover:bg-accent motion-safe:hover:-translate-y-px motion-safe:hover:shadow-sm"
                >
                  /{s}
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
