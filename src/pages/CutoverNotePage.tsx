import { lazy, Suspense, useEffect, useMemo } from "react";
import { useLocation, useParams } from "react-router";
import { EditorSkeleton } from "@/components/note/EditorSkeleton";
import { parseCapabilityLocation } from "@/lib/capability/url";
import { clearLegacyImportRecovery } from "@/lib/legacy/cutover";

interface CutoverNotePageProps {
  /** Ignore capability-shaped fragments while the capability backend is offline. */
  legacyOnly?: boolean;
  /** When provided (e.g. from SplitView), use this slug instead of the route param. */
  embedSlug?: string;
  /** Container-derived layout mode for an embedded split pane. */
  embedNarrow?: boolean;
  /** Reports the pane's active scroll element after lazy/encryption gates open. */
  onPrimaryScroller?: (element: HTMLElement | null) => void;
}

const LegacyNotePage = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true"
  ? lazy(() => import("./LegacyNotePage"))
  : null;
const editorFallback = <EditorSkeleton />;

/** Choice A: this page is mounted only for `?legacyRo=1`. Always LNO, even with #owner/#edit. */
export function CutoverNotePage(props: CutoverNotePageProps) {
  const params = useParams();
  const location = useLocation();
  const slug = props.embedSlug ?? params.slug ?? "";
  const capabilityAccess = useMemo(() => {
    const parsed = typeof window === "undefined"
      ? null
      : parseCapabilityLocation(new URL(
        `${location.pathname}${location.search}${location.hash}`,
        window.location.origin,
      ));
    return parsed && parsed.scope !== "view" && parsed.slug === slug ? parsed : null;
  }, [slug, location.pathname, location.search, location.hash]);

  useEffect(() => {
    if (capabilityAccess?.scope === "owner") {
      clearLegacyImportRecovery(slug, capabilityAccess.token);
    }
  }, [capabilityAccess, slug]);

  if (!LegacyNotePage) return null;
  return (
    <Suspense fallback={editorFallback}>
      <LegacyNotePage
        slug={slug}
        embed={!!props.embedSlug}
        onPrimaryScroller={props.onPrimaryScroller}
      />
    </Suspense>
  );
}

export default CutoverNotePage;
