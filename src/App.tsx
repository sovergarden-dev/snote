import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, useParams } from "react-router";
import { ThemeProvider } from "next-themes";
import { lazy, Suspense } from "react";
import Home from "./pages/Home";
import NotFound from "./pages/NotFound";
import { CommandPalette } from "./components/CommandPalette";
import { DonateButton } from "./components/DonateButton";
import { PwaUpdateDebugPanel } from "./components/dev/PwaUpdateDebugPanel";
import { DiagnosticsPanel, RuntimeErrorBoundary } from "./components/dev/DiagnosticsPanel";
import { EditorSkeleton } from "./components/note/EditorSkeleton";
import { I18nProvider } from "./i18n/provider";
import { loadNotePage } from "./lib/note-page-import";

// Lazy-load heavy routes so the editor / admin bundles only load when needed.
const NotePage = lazy(() => loadNotePage());
const CutoverNotePage = import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true"
  ? lazy(() => import("./pages/CutoverNotePage"))
  : null;
const RawView = lazy(() => import("./pages/RawView"));
const SplitView = lazy(() => import("./pages/SplitView"));
const AdminPanel = import.meta.env.VITE_ADMIN_PANEL_ENABLED === "true"
  ? lazy(() => import("./pages/AdminPanel"))
  : null;
const SharePage = lazy(() => import("./pages/SharePage"));
const Privacy = lazy(() => import("./pages/Privacy"));

const queryClient = new QueryClient();
const capabilityRoutesEnabled =
  import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true";
const adminPanelEnabled =
  import.meta.env.VITE_ADMIN_PANEL_ENABLED === "true";
// EditorSkeleton mimics the topbar + editor layout so there's no shift when
// the lazy NotePage chunk lands.
const EditorFallback = <EditorSkeleton />;
const PlainFallback = (
  <div className="flex h-svh items-center justify-center bg-background">
    <div className="h-7 w-7 animate-spin rounded-full border-2 border-muted border-t-foreground/60" />
  </div>
);

/**
 * SlugDispatcher inspects the single-segment path and routes to the right view.
 */
function SlugDispatcher() {
  const { slug = "" } = useParams();
  if (slug === "note") {
    if (!adminPanelEnabled || !AdminPanel) {
      return <NotFound />;
    }
    return (
      <Suspense fallback={PlainFallback}>
        <AdminPanel />
      </Suspense>
    );
  }
  if (/\.md$/i.test(slug)) {
    return (
      <Suspense fallback={PlainFallback}>
        <RawView />
      </Suspense>
    );
  }
  if (slug.includes("+")) {
    return (
      <Suspense fallback={EditorFallback}>
        <SplitView />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={EditorFallback}>
      {capabilityRoutesEnabled && CutoverNotePage ? (
        <CutoverNotePage />
      ) : (
        <NotePage legacyOnly={!capabilityRoutesEnabled} />
      )}
    </Suspense>
  );
}

const App = () => (
  <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        {/* Toasters live OUTSIDE TooltipProvider — Tooltip's Provider passes a
            ref to its first child and these toaster wrappers are plain function
            components, which produces a noisy "Function components cannot be
            given refs" warning. */}
        <Toaster />
        <Sonner />
        <TooltipProvider delayDuration={200} skipDelayDuration={0}>
          <BrowserRouter>
            <CommandPalette />
            <DonateButton />
            <PwaUpdateDebugPanel />
            <DiagnosticsPanel />
            <RuntimeErrorBoundary>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route
                  path="/privacy"
                  element={
                    <Suspense fallback={PlainFallback}>
                      <Privacy />
                    </Suspense>
                  }
                />
                <Route
                  path="/s"
                  element={
                    <Suspense fallback={PlainFallback}>
                      <SharePage legacyOnly={!capabilityRoutesEnabled} />
                    </Suspense>
                  }
                />
                <Route
                  path="/s/:token"
                  element={
                    <Suspense fallback={PlainFallback}>
                      <SharePage legacyOnly={!capabilityRoutesEnabled} />
                    </Suspense>
                  }
                />
                <Route path="/:slug" element={<SlugDispatcher />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </RuntimeErrorBoundary>
          </BrowserRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>
  </ThemeProvider>
);

export default App;
