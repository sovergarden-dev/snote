// PWA update flow.
//
// When the Ko-fi FAB is eligible it is the primary update UI: no Sonner toast.
// `/note` and `*.md` hide the FAB, so the toast is the fallback. Clicking
// Update / the FAB primary control only marks that build as pending and starts
// one reload path; repeated clicks are ignored while that path is in progress.

import { createElement, type MouseEvent, type ReactNode } from "react";
import { registerSW } from "virtual:pwa-register";
import { toast as sonnerToast } from "sonner";
import {
  detectLang,
  STORAGE_KEY,
  translateLoaded,
  type Lang,
  type TKey,
} from "@/i18n";
import {
  PWA_UPDATE_STATE_EVENT,
  type PwaReloadStrategy,
  type PwaUpdateReadinessState,
} from "@/lib/pwa-update-readiness";
import { shouldHideDonateFab } from "@/lib/donate-fab-visibility";

declare const __BUILD_ID__: string;
const STAMPED_BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

// Tunables — see docs/e2e-env-overrides.md ("PWA update tunables").
function envNum(key: string, fallback: number): number {
  const raw = (import.meta.env as Record<string, string | undefined>)[key];
  const v = raw ? Number(raw) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
const VERSION_POLL_INTERVAL_MS = envNum("VITE_PWA_VERSION_POLL_MS", 60 * 1000);
const SW_UPDATE_POLL_INTERVAL_MS = envNum("VITE_PWA_SW_POLL_MS", 60 * 1000);
const RELOAD_FALLBACK_MS = envNum("VITE_PWA_RELOAD_FALLBACK_MS", 2500);
const TOAST_ID = "pwa-update-toast";
const PENDING_BUILD_KEY = "pwa-update-pending-build";
const RECOVERY_ATTEMPT_KEY = "pwa-update-recovery-attempt";
const LEGACY_VERSION_PARAM = "v";

export type PwaRecoveryReason = "boot-mismatch" | "lazy-import";

// Single source of truth: extend the shared readiness type so UI/E2E and
// runtime writer never drift. `lastRemoteBuildId`/`lastAcceptedAt` are
// required at the writer level (nullable) but optional in the schema.
type ReloadStrategy = PwaReloadStrategy;

type PwaUpdateDebugState = PwaUpdateReadinessState & {
  lastRemoteBuildId: string | null;
  lastAcceptedAt: number | null;
};


declare global {
  interface Window {
    __SNOTE_E2E_ENABLE_PWA_UPDATE__?: boolean;
    __SNOTE_E2E_BUILD_ID__?: string;
    __SNOTE_E2E_PWA_INITIAL_POLL_MS__?: number;
    __SNOTE_E2E_PWA_POLL_INTERVAL_MS__?: number;
    __SNOTE_PWA_UPDATE_STATE__?: PwaUpdateDebugState;
    __SNOTE_PWA_UPDATE_CLEANUP__?: () => void;
    __SNOTE_PWA_APPLY_UPDATE__?: () => void;
    __SNOTE_PWA_SYNC_UPDATE_UI__?: () => void;
  }
}

function tr(lang: Lang, key: TKey): string {
  return translateLoaded(lang, key);
}

function isLovablePreviewHost(): boolean {
  if (typeof window === "undefined") return false;
  return /(^|\.)id-preview--/.test(window.location.hostname);
}

function isE2EUpdateEnabled(): boolean {
  return typeof window !== "undefined" && window.__SNOTE_E2E_ENABLE_PWA_UPDATE__ === true;
}

function getCurrentBuildId(): string {
  if (isE2EUpdateEnabled() && typeof window.__SNOTE_E2E_BUILD_ID__ === "string") {
    return window.__SNOTE_E2E_BUILD_ID__;
  }
  return STAMPED_BUILD_ID;
}

function writeDebugState(next: Partial<PwaUpdateDebugState>): void {
  if (typeof window === "undefined") return;
  const previous = window.__SNOTE_PWA_UPDATE_STATE__ ?? {
    currentBuildId: getCurrentBuildId(),
    pendingBuildId: null,
    updateAvailable: false,
    updateInProgress: false,
    lastRemoteBuildId: null,
    reloadAttemptCount: 0,
    reloadStrategy: null,
    lastAcceptedAt: null,
  };
  window.__SNOTE_PWA_UPDATE_STATE__ = {
    ...previous,
    ...next,
    currentBuildId: getCurrentBuildId(),
  };
  window.dispatchEvent(new Event(PWA_UPDATE_STATE_EVENT));
}

export async function nukeServiceWorkersAndCaches(): Promise<void> {
  // Unregisters the same-origin app worker and drops Workbox caches only.
  // Preview hosts call this on every boot. Production calls it only from
  // recoverMaroonedPwaUpdateOnce (one-shot). Never clears localStorage.
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        regs
          .filter((r) => {
            const scriptUrl = r.active?.scriptURL ?? r.waiting?.scriptURL ?? r.installing?.scriptURL ?? "";
            try {
              const path = new URL(scriptUrl).pathname;
              return path === "/sw.js" || path === "/service-worker.js";
            } catch {
              return true;
            }
          })
          .map((r) => r.unregister().catch(() => false)),
      );
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof caches !== "undefined") {
      const names = await caches.keys();
      const appCacheNames = names.filter((name) => /(^|-)precache-v\d+-|(^|-)runtime-|^workbox-/.test(name));
      await Promise.all(appCacheNames.map((n) => caches.delete(n).catch(() => false)));
    }
  } catch {
    /* ignore */
  }
}

function readSessionItem(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionItem(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/**
 * One-shot production recovery after a marooned Update (or a stuck NotePage
 * import). Unregisters `/sw.js` (+ `/service-worker.js`), deletes Workbox
 * caches, and reloads once. Guarded by sessionStorage so it cannot loop.
 */
export function recoverMaroonedPwaUpdateOnce(reason: PwaRecoveryReason): boolean {
  if (typeof window === "undefined") return false;
  if (isLovablePreviewHost()) return false;
  if (readSessionItem(RECOVERY_ATTEMPT_KEY)) return false;

  const pending = readSessionItem(PENDING_BUILD_KEY);
  const current = getCurrentBuildId();
  if (reason === "boot-mismatch" && (!pending || pending === current)) {
    return false;
  }
  if (reason === "lazy-import") {
    const hasController = Boolean(
      typeof navigator !== "undefined" && navigator.serviceWorker?.controller,
    );
    if (!pending && !hasController) return false;
  }

  writeSessionItem(RECOVERY_ATTEMPT_KEY, pending ?? "1");
  const target = pending ?? "unknown";
  void nukeServiceWorkersAndCaches().finally(() => {
    recoverAndReloadCleanUrl(target);
  });
  return true;
}

function cleanCurrentAppUrl(): string {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete(LEGACY_VERSION_PARAM);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }
}

function scrubLegacyVersionParamFromVisibleUrl(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(LEGACY_VERSION_PARAM)) return;
    url.searchParams.delete(LEGACY_VERSION_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* best effort */
  }
}

function signalE2EReload(targetBuildId: string | null): boolean {
  if (isE2EUpdateEnabled() && targetBuildId) {
    window.__SNOTE_E2E_BUILD_ID__ = targetBuildId;
    window.dispatchEvent(new CustomEvent("snote:e2e-pwa-hard-reload", { detail: { targetBuildId } }));
    return true;
  }
  return false;
}

function reloadCleanUrl(targetBuildId: string | null): void {
  scrubLegacyVersionParamFromVisibleUrl();
  if (signalE2EReload(targetBuildId)) return;
  try {
    const cleanUrl = cleanCurrentAppUrl();
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (cleanUrl === currentUrl) {
      window.location.reload();
    } else {
      window.location.replace(cleanUrl);
    }
  } catch {
    window.location.reload();
  }
}

function recoverAndReloadCleanUrl(targetBuildId: string | null): void {
  scrubLegacyVersionParamFromVisibleUrl();
  if (signalE2EReload(targetBuildId)) return;
  reloadCleanUrl(targetBuildId);
}

function updateButton(label: string, disabled: boolean, onReload: () => void): ReactNode {
  return createElement(
    "button",
    {
      type: "button",
      "data-button": true,
      "data-action": true,
      "data-disabled": disabled ? "true" : undefined,
      disabled,
      onClick: (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        if (!disabled) onReload();
      },
    },
    disabled ? `${label}…` : label,
  );
}

function updateDescription(updateInProgress: boolean): ReactNode {
  const lang = detectLang();
  const bodyKey = updateInProgress ? "update.pending_desc" : "update.description";
  return createElement(
    "div",
    { "data-pwa-update-state": updateInProgress ? "pending" : "available" },
    createElement("div", null, tr(lang, bodyKey)),
  );
}

/** FAB is primary whenever it is in the DOM or the route would render it. */
function isFabUpdatePrimary(): boolean {
  if (typeof document !== "undefined" && document.querySelector("[data-donate-fab]")) {
    return true;
  }
  if (typeof window === "undefined") return false;
  return !shouldHideDonateFab(window.location.pathname);
}

function showUpdateToast(options: {
  updateInProgress: boolean;
  onReload: () => void;
}): void {
  if (isFabUpdatePrimary()) {
    sonnerToast.dismiss(TOAST_ID);
    return;
  }
  const lang = detectLang();
  const titleKey = options.updateInProgress ? "update.pending_title" : "update.title";
  sonnerToast(tr(lang, titleKey), {
    id: TOAST_ID,
    description: updateDescription(options.updateInProgress),
    duration: Infinity,
    action: updateButton(tr(lang, "update.btn_reload"), options.updateInProgress, options.onReload),
  });
}

async function readRemoteVersion(): Promise<{ buildId?: string } | null> {
  const res = await fetch(`/version.json?ts=${Date.now()}`, {
    cache: "no-store",
    credentials: "omit",
  });
  if (!res.ok) return null;
  return (await res.json()) as { buildId?: string };
}

function startVersionPoller(
  onMismatch: (remoteBuildId: string) => void,
  onCurrent: (remoteBuildId: string) => void,
): () => void {
  let stopped = false;
  const check = async () => {
    if (stopped) return;
    try {
      const data = await readRemoteVersion();
      const currentBuildId = getCurrentBuildId();
      if (data?.buildId && data.buildId !== currentBuildId) {
        console.log(`[pwa-update] mismatch current=${currentBuildId} remote=${data.buildId}`);
        onMismatch(data.buildId);
      } else if (data?.buildId) {
        onCurrent(data.buildId);
      }
    } catch {
      /* network blip — try again next tick */
    }
  };

  const initialDelay = isE2EUpdateEnabled() ? (window.__SNOTE_E2E_PWA_INITIAL_POLL_MS__ ?? 50) : 3000;
  const interval = isE2EUpdateEnabled() ? (window.__SNOTE_E2E_PWA_POLL_INTERVAL_MS__ ?? 250) : VERSION_POLL_INTERVAL_MS;
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") void check();
  };
  const onFocus = () => void check();

  const initialTimer = window.setTimeout(check, initialDelay) as unknown as number;
  const timer = window.setInterval(check, interval) as unknown as number;
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("focus", onFocus);

  return () => {
    stopped = true;
    window.clearTimeout(initialTimer);
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("focus", onFocus);
  };
}

export function registerAppUpdater(): void {
  if (typeof window === "undefined") return;
  window.__SNOTE_PWA_UPDATE_CLEANUP__?.();
  window.__SNOTE_PWA_UPDATE_CLEANUP__ = undefined;
  scrubLegacyVersionParamFromVisibleUrl();

  if (import.meta.env.DEV && !isE2EUpdateEnabled()) return;

  if (isLovablePreviewHost()) {
    void nukeServiceWorkersAndCaches();
    return;
  }

  let pendingBuildFromPreviousLoad: string | null = null;
  try {
    pendingBuildFromPreviousLoad = sessionStorage.getItem(PENDING_BUILD_KEY);
  } catch {
    /* ignore */
  }
  if (pendingBuildFromPreviousLoad && pendingBuildFromPreviousLoad === getCurrentBuildId()) {
    try {
      sessionStorage.removeItem(PENDING_BUILD_KEY);
    } catch {
      /* ignore */
    }
    pendingBuildFromPreviousLoad = null;
    sonnerToast.dismiss(TOAST_ID);
  }

  if (recoverMaroonedPwaUpdateOnce("boot-mismatch")) {
    return;
  }

  let updateAvailable = false;
  let latestRemoteBuildId: string | null = null;
  let waitingRegistration: ServiceWorkerRegistration | null = null;
  let updateSWFn: ((reload?: boolean) => Promise<void>) | null = null;
  let reloadInProgress = false;
  let reloadAttemptCount = 0;
  let reloadStrategy: ReloadStrategy = null;
  let waitingNeedRefreshBuildId: string | null = null;
  const cleanupTasks: Array<() => void> = [];
  window.__SNOTE_PWA_UPDATE_CLEANUP__ = () => {
    while (cleanupTasks.length) {
      cleanupTasks.pop()?.();
    }
  };

  const syncDebugState = () => {
    writeDebugState({
      pendingBuildId: latestRemoteBuildId ?? pendingBuildFromPreviousLoad,
      updateAvailable,
      updateInProgress: reloadInProgress,
      lastRemoteBuildId: latestRemoteBuildId,
      reloadAttemptCount,
      reloadStrategy,
    });
  };

  const reloadNow = () => {
    if (reloadInProgress) return;
    reloadInProgress = true;
    reloadAttemptCount += 1;
    const pendingBuildId = latestRemoteBuildId ?? pendingBuildFromPreviousLoad;
    if (pendingBuildId) {
      try {
        sessionStorage.setItem(PENDING_BUILD_KEY, pendingBuildId);
      } catch {
        /* ignore */
      }
    }
    syncDebugState();
    writeDebugState({ pendingBuildId: pendingBuildId ?? null, lastAcceptedAt: Date.now() });
    syncPresentation();
    const reloadTarget = pendingBuildId ?? getCurrentBuildId();
    // Lifecycle log happens after strategy is chosen below.

    if (waitingRegistration?.waiting && updateSWFn) {
      reloadStrategy = "waiting-sw";
      syncDebugState();
      console.log("[pwa-update] reload strategy=waiting-sw", { currentBuildId: getCurrentBuildId(), pendingBuildId: reloadTarget });
      logLifecycle("reload-start");
      const fallback = window.setTimeout(() => {
        console.log("[pwa-update] waiting-sw fallback → hard reload", { currentBuildId: getCurrentBuildId(), pendingBuildId: reloadTarget });
        recoverAndReloadCleanUrl(reloadTarget);
      }, RELOAD_FALLBACK_MS);
      let done = false;
      const onCtrl = () => {
        if (done) return;
        done = true;
        window.clearTimeout(fallback);
        reloadCleanUrl(reloadTarget);
      };
      navigator.serviceWorker?.addEventListener("controllerchange", onCtrl, { once: true });
      cleanupTasks.push(() => navigator.serviceWorker?.removeEventListener("controllerchange", onCtrl));
      scrubLegacyVersionParamFromVisibleUrl();
      void updateSWFn(false).catch(() => {
        window.clearTimeout(fallback);
        recoverAndReloadCleanUrl(reloadTarget);
      });
      return;
    }

    reloadStrategy = "hard";
    syncDebugState();
    console.log("[pwa-update] reload strategy=hard", { currentBuildId: getCurrentBuildId(), pendingBuildId: reloadTarget });
    logLifecycle("reload-start");
    recoverAndReloadCleanUrl(reloadTarget);
  };

  window.__SNOTE_PWA_APPLY_UPDATE__ = reloadNow;
  cleanupTasks.push(() => {
    if (window.__SNOTE_PWA_APPLY_UPDATE__ === reloadNow) {
      delete window.__SNOTE_PWA_APPLY_UPDATE__;
    }
  });

  const logLifecycle = (event: string) => {
    const payload = {
      event,
      currentBuildId: getCurrentBuildId(),
      pendingBuildId: latestRemoteBuildId ?? pendingBuildFromPreviousLoad,
      reloadStrategy,
      reloadAttemptCount,
      updateAvailable,
      updateInProgress: reloadInProgress,
      at: new Date().toISOString(),
    };
    console.info("[pwa-update:lifecycle]", payload);
  };

  const syncPresentation = () => {
    if (updateAvailable && !isFabUpdatePrimary()) {
      showUpdateToast({
        updateInProgress: reloadInProgress,
        onReload: reloadNow,
      });
      return;
    }
    sonnerToast.dismiss(TOAST_ID);
  };

  const presentUpdate = () => {
    updateAvailable = true;
    syncDebugState();
    if (isFabUpdatePrimary()) {
      sonnerToast.dismiss(TOAST_ID);
    }
    syncPresentation();
    logLifecycle(isFabUpdatePrimary() ? "fab-update-shown" : "toast-shown");
  };

  window.__SNOTE_PWA_SYNC_UPDATE_UI__ = syncPresentation;
  cleanupTasks.push(() => {
    if (window.__SNOTE_PWA_SYNC_UPDATE_UI__ === syncPresentation) {
      delete window.__SNOTE_PWA_SYNC_UPDATE_UI__;
    }
  });

  // On-demand debug dump for humans (paste `__SNOTE_PWA_UPDATE_DEBUG__()`
  // into the devtools console to see current vs pending buildId + strategy).
  (window as unknown as { __SNOTE_PWA_UPDATE_DEBUG__?: () => PwaUpdateDebugState | undefined }).__SNOTE_PWA_UPDATE_DEBUG__ =
    () => {
      logLifecycle("manual-dump");
      return window.__SNOTE_PWA_UPDATE_STATE__;
    };

  syncDebugState();
  cleanupTasks.push(startVersionPoller(
    (remoteBuildId) => {
      latestRemoteBuildId = remoteBuildId;
      pendingBuildFromPreviousLoad = remoteBuildId;
      presentUpdate();
    },
    (remoteBuildId) => {
      if (remoteBuildId !== getCurrentBuildId()) return;
      // Waiting SW said refresh is needed, but this tab is still on the same
      // build. version.json matching the running app is not "transition complete".
      if (
        waitingNeedRefreshBuildId !== null &&
        getCurrentBuildId() === waitingNeedRefreshBuildId
      ) {
        return;
      }
      waitingNeedRefreshBuildId = null;
      updateAvailable = false;
      latestRemoteBuildId = remoteBuildId;
      reloadInProgress = false;
      try {
        if (sessionStorage.getItem(PENDING_BUILD_KEY) === remoteBuildId) {
          sessionStorage.removeItem(PENDING_BUILD_KEY);
        }
      } catch {
        /* ignore */
      }
      sonnerToast.dismiss(TOAST_ID);
      writeDebugState({
        pendingBuildId: null,
        updateAvailable,
        updateInProgress: false,
        lastRemoteBuildId: remoteBuildId,
        reloadAttemptCount,
        reloadStrategy,
      });
      logLifecycle("transition-complete");
    },
  ));

  if (!("serviceWorker" in navigator) || isE2EUpdateEnabled()) return;

  updateSWFn = registerSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      waitingRegistration = registration;
      registration.update().catch(() => {});
      const swUpdateTimer = window.setInterval(() => {
        registration.update().catch(() => {});
      }, SW_UPDATE_POLL_INTERVAL_MS);
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") {
          registration.update().catch(() => {});
        }
      };
      const onFocus = () => {
        registration.update().catch(() => {});
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("focus", onFocus);
      cleanupTasks.push(() => {
        window.clearInterval(swUpdateTimer);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("focus", onFocus);
      });
    },
    onNeedRefresh() {
      waitingNeedRefreshBuildId = getCurrentBuildId();
      presentUpdate();
      void readRemoteVersion()
        .then((remote) => {
          if (remote?.buildId && remote.buildId !== getCurrentBuildId()) {
            latestRemoteBuildId = remote.buildId;
            syncDebugState();
          }
        })
        .catch(() => {
          /* keep previous poller value */
        });
    },
  });

  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY && updateAvailable) syncPresentation();
  };
  const onLangChanged = () => {
    if (updateAvailable) syncPresentation();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("i18n:lang-changed", onLangChanged);
  cleanupTasks.push(() => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("i18n:lang-changed", onLangChanged);
  });
}
