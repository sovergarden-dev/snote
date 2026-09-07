import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import App from "./App.tsx";
import "./index.css";
import { postExtensionReady } from "./lib/ext-context";
import { sanitizeLegacyShareUrl } from "./lib/legacy/share-url";

// Run before BrowserRouter reads location. The old /s/:token request has
// already reached the host, but the raw token must not persist in SPA history,
// referrers, screenshots, or subsequent client navigation.
sanitizeLegacyShareUrl(window.location, window.history);

createRoot(document.getElementById("root")!).render(
  <HelmetProvider>
    <App />
  </HelmetProvider>,
);

// Tell the Chrome extension side panel we're mounted so it can hide its
// loader based on real app state, not just iframe.onload. No-op outside
// the extension.
queueMicrotask(postExtensionReady);

// Register the PWA service worker. FAB-eligible routes suppress Sonner; the
// toast is the fallback on /note and *.md. Loaded lazily so SW + workbox glue
// stay out of the eager entry chunk (keeps the bundle-size gate happy and
// doesn't block first paint). See src/lib/pwa-update.ts for the rationale.
void import("./lib/pwa-update").then((m) => m.registerAppUpdater());

// Web Vitals — log to console for DevTools observation in any environment.
import("web-vitals").then(({ onINP, onLCP, onCLS }) => {
  const log = (name: string) => (m: { value: number }) =>
    console.log(`[perf] ${name}=${Math.round(m.value * 100) / 100}ms`);
  onINP(log("INP"));
  onLCP(log("LCP"));
  onCLS((m) => console.log(`[perf] CLS=${Math.round(m.value * 1000) / 1000}`));
});
