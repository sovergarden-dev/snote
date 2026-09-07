import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router";
import { Helmet } from "react-helmet-async";
import { ArrowLeft, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AppShell } from "@/components/app/AppShell";
import { useSceneTheme } from "@/hooks/use-scene-theme";
import { saveLastSplitView } from "@/lib/split-view-persistence";
import {
  useSplitScrollSync,
  type SplitScrollerRegistration,
} from "@/hooks/use-split-scroll-sync";
import { useI18n } from "@/i18n";
import { loadNotePage } from "@/lib/note-page-import";
import { isUsableSlug } from "@/lib/slug";
import { WIKI_NAV_EVENT } from "@/lib/wiki-link";

const NotePage = lazy(() => loadNotePage());
const CutoverNotePage = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true"
  ? lazy(() => import("./CutoverNotePage"))
  : null;
const capabilityRoutesEnabled =
  import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true";

const SLUG_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MIN_PANES = 2;
const MAX_PANES = 4;

/**
 * SplitView shows 2–4 notes at once. Route: /:slugs where slugs = "a+b",
 * "a+b+c", or "a+b+c+d". Optional sync-scroll keeps every pane at the same
 * scroll ratio.
 *
 * Layouts:
 *   2 → left | right
 *   3 → top row (n1 | n2), bottom row = n3 full width
 *   4 → 2×2 grid
 */
export default function SplitView() {
  const { slug = "" } = useParams();
  const [syncScroll, setSyncScroll] = useState(true);

  // Deduplicate: identical slugs on multiple panes cause provider/presence
  // conflicts. Preserve first-occurrence order.
  const rawSlugs = useMemo(() => slug.split("+").filter(Boolean), [slug]);
  const slugs = useMemo(() => Array.from(new Set(rawSlugs)), [rawSlugs]);
  const registerScroller = useSplitScrollSync(syncScroll, slugs.length);

  // Invalid: wrong count or any slug fails the regex → go home.
  if (
    rawSlugs.length < MIN_PANES ||
    rawSlugs.length > MAX_PANES ||
    rawSlugs.some((s) => !SLUG_RE.test(s))
  ) {
    return <Navigate to="/" replace />;
  }
  // All identical → collapse to single-note route.
  if (slugs.length === 1) {
    return <Navigate to={`/${slugs[0]}`} replace />;
  }
  // Some duplicates removed → redirect to the canonical unique-slug URL.
  if (slugs.length !== rawSlugs.length) {
    return <Navigate to={`/${slugs.join("+")}`} replace />;
  }

  return (
    <SplitViewBody
      slugs={slugs}
      syncScroll={syncScroll}
      setSyncScroll={setSyncScroll}
      registerScroller={registerScroller}
    />
  );
}

function SplitViewBody({
  slugs,
  syncScroll,
  setSyncScroll,
  registerScroller,
}: {
  slugs: string[];
  syncScroll: boolean;
  setSyncScroll: (v: (b: boolean) => boolean) => void;
  registerScroller: SplitScrollerRegistration;
}) {
  const { scene } = useSceneTheme();
  const { t } = useI18n();
  const navigate = useNavigate();
  const hasScene = scene !== "none";
  const joined = slugs.join("+");
  const label = slugs.map((s) => `/${s}`).join(" + ");
  const canonical = `https://note.syrin.online/${joined}`;
  const title = `Split view: ${label} — Syrin Notes`;
  const desc = `Compare ${slugs.length} markdown notes side by side (${label}) with synced scrolling on Syrin Notes.`;
  const [workspaceRef, compact] = useElementNarrow<HTMLElement>(768);
  const [activePane, setActivePane] = useState(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Persist current split path so a future "Return to split view" affordance
  // (or a quick remount after Home nav) can restore it. sessionStorage only —
  // this is transient state, not a preference.
  useEffect(() => {
    saveLastSplitView(slugs);
  }, [joined]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onNav = (event: Event) => {
      const target = (event as CustomEvent<{ slug: string }>).detail?.slug?.trim();
      if (!target || !isUsableSlug(target)) return;
      const existing = slugs.indexOf(target);
      if (existing >= 0) {
        setActivePane(existing);
        tabRefs.current[existing]?.focus();
        return;
      }
      const next = slugs.slice();
      const index = Math.min(Math.max(activePane, 0), next.length - 1);
      next[index] = target;
      if (new Set(next).size !== next.length) return;
      navigate("/" + next.join("+"));
    };
    window.addEventListener(WIKI_NAV_EVENT, onNav);
    return () => window.removeEventListener(WIKI_NAV_EVENT, onNav);
  }, [navigate, slugs, activePane]);

  useEffect(() => {
    setActivePane((index) => Math.min(index, slugs.length - 1));
  }, [slugs.length]);

  const activateFromKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % slugs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + slugs.length) % slugs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = slugs.length - 1;
    else return;
    event.preventDefault();
    setActivePane(next);
    tabRefs.current[next]?.focus();
  };

  // Layout: 2 → 2 cols; 3 → 2×2 grid, last spans both cols; 4 → 2×2 grid.
  const gridClass =
    slugs.length === 2
      ? "grid-cols-1 md:grid-cols-2"
      : "grid-cols-1 md:grid-cols-2 md:grid-rows-2";

  return (
    <AppShell className="flex h-svh flex-col">
      <Helmet>
        <title>{title}</title>
        <meta name="description" content={desc} />
        <link rel="canonical" href={canonical} />
        {/* eslint-disable-next-line no-restricted-syntax -- SEO control value */}
        <meta name="robots" content="noindex, follow" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={desc} />
        <meta property="og:url" content={canonical} />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={desc} />
      </Helmet>
      <header
        className={
          "flex h-11 shrink-0 items-center gap-3 border-b px-3 text-xs " +
          (hasScene
            ? "motion-safe:backdrop-blur-md"
            : "border-border bg-background/95")
        }
        style={
          hasScene
            ? { background: "var(--home-chrome-bg)", borderColor: "var(--home-chrome-border)" }
            : undefined
        }
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to="/"
              className="text-muted-foreground hover:text-foreground"
              aria-label={t("brand.home")}
              onContextMenu={(e) => {
                e.preventDefault();
                window.open("/", "_blank", "noopener,noreferrer");
              }}
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("share.back_home_aria")}</TooltipContent>
        </Tooltip>
        <span className="font-mono truncate">
          {slugs.map((s, i) => (
            <span key={`${s}-${i}`}>
              {i > 0 && <span className="text-muted-foreground"> + </span>}
              /{s}
            </span>
          ))}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant={syncScroll ? "default" : "outline"}
              className="ml-auto h-7"
              onClick={() => setSyncScroll((v) => !v)}
              aria-pressed={syncScroll}
              aria-label={`Sync scroll ${syncScroll ? "ON" : "OFF"}`}
            >
              <Link2 className="h-3.5 w-3.5" />
              Sync scroll {syncScroll ? "ON" : "OFF"}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {syncScroll
              ? "Syncing scroll across all panels. Click to disable."
              : "Click to enable synced scrolling between all notes."}
          </TooltipContent>
        </Tooltip>
      </header>
      {compact && (
        <div
          role="tablist"
          aria-label={t("help.split_label")}
          className="flex shrink-0 overflow-x-auto border-b border-border bg-background px-1"
        >
          {slugs.map((paneSlug, index) => (
            <button
              key={paneSlug}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              id={`split-tab-${index}`}
              type="button"
              role="tab"
              aria-selected={activePane === index}
              aria-controls={`split-panel-${index}`}
              tabIndex={activePane === index ? 0 : -1}
              className={`min-h-11 flex-1 truncate border-b-2 px-3 font-mono text-xs ${
                activePane === index
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground"
              }`}
              onClick={() => setActivePane(index)}
              onKeyDown={(event) => activateFromKey(event, index)}
            >
              /{paneSlug}
            </button>
          ))}
        </div>
      )}
      <main
        ref={workspaceRef}
        data-split-workspace
        className={`flex-1 min-h-0 bg-background divide-border ${
          compact ? "flex" : `grid ${gridClass}`
        }`}
      >
        {slugs.map((s, i) => {
          // For 3-pane layout the third pane spans both columns to fill the
          // bottom row.
          const spanClass = slugs.length === 3 && i === 2 ? "md:col-span-2" : "";
          // Borders between panes: right border for left column, bottom border
          // for top row. Simpler than divide-* which doesn't handle the 3-pane
          // asymmetric layout.
          const borderClass = [
            // vertical divider between columns (all layouts, not on last column)
            i % 2 === 0 && !(slugs.length === 3 && i === 2) ? "md:border-r md:border-border" : "",
            // horizontal divider between rows (3/4-pane, top row only)
            slugs.length >= 3 && i < 2 ? "border-b border-border md:border-b" : "",
            // mobile stacking: separator between stacked panes
            i > 0 ? "border-t border-border md:border-t-0" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <SplitPane
              key={`${s}-${i}`}
              index={i}
              slug={s}
              compact={compact}
              active={activePane === i}
              className={`${spanClass} ${borderClass}`}
              registerScroller={registerScroller}
              onActivate={() => setActivePane(i)}
            />
          );
        })}
      </main>
    </AppShell>
  );
}

function SplitPane({
  index,
  slug,
  compact,
  active,
  className,
  registerScroller,
  onActivate,
}: {
  index: number;
  slug: string;
  compact: boolean;
  active: boolean;
  className: string;
  registerScroller: SplitScrollerRegistration;
  onActivate: () => void;
}) {
  const { search } = useLocation();
  const legacyRo = new URLSearchParams(search).get("legacyRo") === "1";
  const [paneRef, paneNarrow] = useElementNarrow<HTMLDivElement>(900);
  const onPrimaryScroller = useCallback(
    (element: HTMLElement | null) => registerScroller(index, element),
    [index, registerScroller],
  );

  return (
    <div
      ref={paneRef}
      id={`split-panel-${index}`}
      data-split-view-pane={index}
      data-split-view-slug={slug}
      data-split-active={active ? "true" : undefined}
      role={compact ? "tabpanel" : "region"}
      aria-labelledby={compact ? `split-tab-${index}` : undefined}
      aria-label={compact ? undefined : `/${slug}`}
      hidden={compact && !active}
      tabIndex={-1}
      onPointerDown={onActivate}
      className={`min-h-0 min-w-0 flex-1 overflow-hidden ${className}`}
    >
      <Suspense
        fallback={
          <div
            className="flex h-full items-center justify-center bg-background text-xs text-muted-foreground"
            role="status"
          >
            Loading /{slug}…
          </div>
        }
      >
        {legacyRo && capabilityRoutesEnabled && CutoverNotePage ? (
          <CutoverNotePage
            embedSlug={slug}
            embedNarrow={paneNarrow}
            onPrimaryScroller={onPrimaryScroller}
          />
        ) : (
          <NotePage
            legacyOnly={!capabilityRoutesEnabled}
            embedSlug={slug}
            embedNarrow={paneNarrow}
            onPrimaryScroller={onPrimaryScroller}
          />
        )}
      </Suspense>
    </div>
  );
}

function useElementNarrow<T extends HTMLElement>(threshold: number) {
  const [element, setElement] = useState<T | null>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number") setNarrow(width < threshold);
    });
    observer.observe(element);
    const initialWidth = element.getBoundingClientRect().width;
    if (initialWidth > 0) setNarrow(initialWidth < threshold);
    return () => observer.disconnect();
  }, [element, threshold]);

  return [setElement, narrow] as const;
}
