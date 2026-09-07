// Unit tests for the PWA update logic. We mock the virtual PWA register module,
// sonner, and /version.json fetches so we can drive the toast lifecycle directly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RegisterSWOptions = {
  onRegisteredSW?: (swUrl: string, registration?: ServiceWorkerRegistration) => void;
  onNeedRefresh?: () => void | Promise<void>;
};

const registerSWMock = vi.fn<(opts: RegisterSWOptions) => (reload?: boolean) => Promise<void>>();
const toastMock = vi.fn();
const dismissMock = vi.fn();

vi.mock("virtual:pwa-register", () => ({
  registerSW: (opts: RegisterSWOptions) => registerSWMock(opts),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(toastMock, { dismiss: dismissMock }),
}));

vi.mock("@/i18n", () => ({
  detectLang: () => "en",
  STORAGE_KEY: "lang",
  translateLoaded: (_lang: string, key: string) =>
    ({
      "update.title": "New version available",
      "update.pending_title": "Update pending",
      "update.pending_desc": "Applying the update.",
      "update.description": "Reload for the latest version.",
      "update.btn_reload": "Update",
    })[key] ?? key,
}));

async function fresh() {
  vi.resetModules();
  return await import("../pwa-update");
}

function respondVersion(buildId: string) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ buildId }),
  }));
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function flush(ms = 30) {
  await new Promise((r) => setTimeout(r, ms));
}

function setPathname(pathname: string) {
  window.history.replaceState(window.history.state, "", pathname);
}

function pwaState() {
  return window.__SNOTE_PWA_UPDATE_STATE__;
}

function clickToastAction() {
  const lastCall = toastMock.mock.calls.at(-1)!;
  const opts = lastCall[1] as { action: { props: { onClick: (e: Event) => void } } };
  opts.action.props.onClick({ preventDefault: () => {} } as unknown as Event);
}

function installServiceWorkerHarness(
  updateSW: (reload?: boolean) => Promise<void>,
) {
  const unregister = vi.fn(async () => true);
  const registration = {
    active: { scriptURL: "https://note.syrin.online/sw.js" },
    waiting: {},
    installing: null,
    update: vi.fn(async () => {}),
    unregister,
  } as unknown as ServiceWorkerRegistration;
  const serviceWorker = {
    getRegistrations: vi.fn(async () => [registration]),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const deleteCache = vi.fn(async () => true);
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: serviceWorker,
  });
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: false,
  });
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      keys: vi.fn(async () => ["workbox-runtime", "precache-v1-assets"]),
      delete: deleteCache,
    },
  });
  registerSWMock.mockReturnValue(updateSW);
  return { registration, unregister, deleteCache };
}

function silenceJsdomReloadWarning() {
  const original = console.error.bind(console);
  return vi.spyOn(console, "error").mockImplementation((first, ...rest) => {
    if (String(first).includes("Not implemented: navigation")) return;
    original(first, ...rest);
  });
}

describe("registerAppUpdater", () => {
  beforeEach(() => {
    registerSWMock.mockReset();
    registerSWMock.mockReturnValue(async () => {});
    toastMock.mockReset();
    dismissMock.mockReset();
    (window as unknown as { __SNOTE_E2E_ENABLE_PWA_UPDATE__?: boolean }).__SNOTE_E2E_ENABLE_PWA_UPDATE__ = true;
    (window as unknown as { __SNOTE_E2E_BUILD_ID__?: string }).__SNOTE_E2E_BUILD_ID__ = "build-a";
    (window as unknown as { __SNOTE_E2E_PWA_INITIAL_POLL_MS__?: number }).__SNOTE_E2E_PWA_INITIAL_POLL_MS__ = 1;
    (window as unknown as { __SNOTE_E2E_PWA_POLL_INTERVAL_MS__?: number }).__SNOTE_E2E_PWA_POLL_INTERVAL_MS__ = 20;
    (window as unknown as { __SNOTE_PWA_UPDATE_STATE__?: unknown }).__SNOTE_PWA_UPDATE_STATE__ = undefined;
    sessionStorage.clear();
    setPathname("/");
  });

  afterEach(() => {
    (window as unknown as { __SNOTE_PWA_UPDATE_CLEANUP__?: () => void }).__SNOTE_PWA_UPDATE_CLEANUP__?.();
    delete (window as unknown as { __SNOTE_PWA_UPDATE_CLEANUP__?: () => void }).__SNOTE_PWA_UPDATE_CLEANUP__;
    delete (window as unknown as { __SNOTE_E2E_ENABLE_PWA_UPDATE__?: boolean }).__SNOTE_E2E_ENABLE_PWA_UPDATE__;
    delete (window as unknown as { __SNOTE_E2E_BUILD_ID__?: string }).__SNOTE_E2E_BUILD_ID__;
    Reflect.deleteProperty(navigator, "serviceWorker");
    Reflect.deleteProperty(globalThis, "caches");
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preserves the active offline worker and caches when the waiting worker rejects", async () => {
    const navigationWarning = silenceJsdomReloadWarning();
    vi.stubEnv("DEV", false);
    (window as unknown as { __SNOTE_E2E_ENABLE_PWA_UPDATE__?: boolean }).__SNOTE_E2E_ENABLE_PWA_UPDATE__ = false;
    respondVersion("build-b");
    const updateSW = vi.fn(async () => {
      throw new Error("waiting worker rejected");
    });
    const { registration, unregister, deleteCache } = installServiceWorkerHarness(updateSW);
    const mod = await fresh();
    mod.registerAppUpdater();
    const opts = registerSWMock.mock.calls[0][0];
    opts.onRegisteredSW?.("/sw.js", registration);
    await opts.onNeedRefresh?.();

    window.__SNOTE_PWA_APPLY_UPDATE__?.();
    await flush(20);

    expect(updateSW).toHaveBeenCalledWith(false);
    expect(unregister).not.toHaveBeenCalled();
    expect(deleteCache).not.toHaveBeenCalled();
    navigationWarning.mockRestore();
  });

  it("preserves the active offline worker and caches when activation stalls", async () => {
    const navigationWarning = silenceJsdomReloadWarning();
    vi.useFakeTimers();
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_PWA_RELOAD_FALLBACK_MS", "25");
    (window as unknown as { __SNOTE_E2E_ENABLE_PWA_UPDATE__?: boolean }).__SNOTE_E2E_ENABLE_PWA_UPDATE__ = false;
    respondVersion("build-b");
    const updateSW = vi.fn(() => new Promise<void>(() => {}));
    const { registration, unregister, deleteCache } = installServiceWorkerHarness(updateSW);
    const mod = await fresh();
    mod.registerAppUpdater();
    const opts = registerSWMock.mock.calls[0][0];
    opts.onRegisteredSW?.("/sw.js", registration);
    await opts.onNeedRefresh?.();

    window.__SNOTE_PWA_APPLY_UPDATE__?.();
    await vi.advanceTimersByTimeAsync(25);

    expect(updateSW).toHaveBeenCalledWith(false);
    expect(unregister).not.toHaveBeenCalled();
    expect(deleteCache).not.toHaveBeenCalled();
    navigationWarning.mockRestore();
  });

  it("keeps the toast open until the running buildId actually changes to the remote build", async () => {
    setPathname("/note");
    respondVersion("build-b");
    const mod = await fresh();
    mod.registerAppUpdater();
    await flush(80);

    expect(toastMock).toHaveBeenCalled();
    // Not dismissed while buildId still mismatched.
    expect(dismissMock).not.toHaveBeenCalled();

    // Simulate reload succeeding: swap the reported buildId, next poll matches.
    (window as unknown as { __SNOTE_E2E_BUILD_ID__?: string }).__SNOTE_E2E_BUILD_ID__ = "build-b";
    await flush(80);

    expect(dismissMock).toHaveBeenCalledWith("pwa-update-toast");
    const state = pwaState();
    expect(state?.currentBuildId).toBe("build-b");
    expect(state?.pendingBuildId).toBeNull();
  });

  it("keeps the toast open when the reload silently keeps the old buildId", async () => {
    setPathname("/note");
    respondVersion("build-b");
    const mod = await fresh();
    mod.registerAppUpdater();
    await flush(80);

    dismissMock.mockClear();
    // Reload attempt but buildId did NOT change — poller keeps seeing mismatch.
    await flush(80);
    expect(dismissMock).not.toHaveBeenCalled();
    const state = pwaState();
    expect(state?.currentBuildId).toBe("build-a");
    expect(state?.updateAvailable).toBe(true);
  });

  it("uses the hard-reload strategy when no waiting service worker is available (E2E mode)", async () => {
    respondVersion("build-b");
    const mod = await fresh();
    mod.registerAppUpdater();
    await flush(80);

    window.__SNOTE_PWA_APPLY_UPDATE__?.();

    const state = pwaState();
    expect(state?.reloadAttemptCount).toBe(1);
    expect(state?.reloadStrategy).toBe("hard");
    expect(state?.pendingBuildId).toBe("build-b");
    expect(sessionStorage.getItem("pwa-update-pending-build")).toBe("build-b");
  });

  it("ignores repeated Update clicks while a reload is already in progress", async () => {
    respondVersion("build-b");
    const mod = await fresh();
    mod.registerAppUpdater();
    await flush(80);

    window.__SNOTE_PWA_APPLY_UPDATE__?.();
    window.__SNOTE_PWA_APPLY_UPDATE__?.();
    window.__SNOTE_PWA_APPLY_UPDATE__?.();

    expect(pwaState()?.reloadAttemptCount).toBe(1);
  });

  it("clears the pwa-update-pending-build sessionStorage entry after the buildId transitions", async () => {
    setPathname("/note");
    respondVersion("build-b");
    const mod = await fresh();
    mod.registerAppUpdater();
    await flush(80);

    clickToastAction();

    // Simulate the reload completing: reported buildId matches remote.
    (window as unknown as { __SNOTE_E2E_BUILD_ID__?: string }).__SNOTE_E2E_BUILD_ID__ = "build-b";
    await flush(80);

    expect(sessionStorage.getItem("pwa-update-pending-build")).toBeNull();
    expect(dismissMock).toHaveBeenCalledWith("pwa-update-toast");
  });

  it("re-issues the toast under the same id when Update is clicked", async () => {
    setPathname("/note");
    respondVersion("build-b");
    const mod = await fresh();
    mod.registerAppUpdater();
    await flush(80);

    const callsBefore = toastMock.mock.calls.length;
    clickToastAction();

    // Toast re-issued with same id so it visually replaces (not stacks).
    expect(toastMock.mock.calls.length).toBeGreaterThan(callsBefore);
    const lastOpts = toastMock.mock.calls.at(-1)![1] as { id: string };
    expect(lastOpts.id).toBe("pwa-update-toast");
  });

  it("keeps build ids out of the user-facing toast and shows a single-line body", async () => {
    setPathname("/note");
    respondVersion("build-b");
    const mod = await fresh();
    mod.registerAppUpdater();
    await flush(80);

    const lastOpts = toastMock.mock.calls.at(-1)![1] as { description: unknown };
    const serialized = JSON.stringify(lastOpts.description);
    expect(serialized).toContain("Reload for the latest version.");
    expect(serialized).not.toContain("clear this site's data/cookies");
    expect(serialized).not.toContain("update.fallback_cleanup");
    expect(serialized).not.toContain("Current:");
    expect(serialized).not.toContain("Pending:");
    expect(serialized).not.toContain("Transition:");
    expect(serialized).not.toContain("build-a");
    expect(serialized).not.toContain("build-b");
  });

  it("dispatches snote:pwa-update-state and wires __SNOTE_PWA_APPLY_UPDATE__", async () => {
    respondVersion("build-b");
    const seen: string[] = [];
    window.addEventListener("snote:pwa-update-state", () => {
      seen.push(window.__SNOTE_PWA_UPDATE_STATE__?.pendingBuildId ?? "");
    });
    const mod = await fresh();
    mod.registerAppUpdater();
    await flush(80);

    expect(seen.length).toBeGreaterThan(0);
    expect(pwaState()?.updateAvailable).toBe(true);
    expect(typeof window.__SNOTE_PWA_APPLY_UPDATE__).toBe("function");
    expect(toastMock).not.toHaveBeenCalled();

    window.__SNOTE_PWA_APPLY_UPDATE__?.();
    expect(pwaState()?.reloadAttemptCount).toBe(1);
    expect(pwaState()?.reloadStrategy).toBe("hard");
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("does not show a Sonner toast on FAB-eligible routes; still publishes update state", async () => {
    respondVersion("build-b");
    const mod = await fresh();
    mod.registerAppUpdater();
    await flush(80);

    expect(toastMock).not.toHaveBeenCalled();
    expect(dismissMock).toHaveBeenCalledWith("pwa-update-toast");
    expect(pwaState()?.updateAvailable).toBe(true);
  });

  it("shows the Sonner toast on /note when the FAB is hidden", async () => {
    setPathname("/note");
    respondVersion("build-b");
    const mod = await fresh();
    mod.registerAppUpdater();
    await flush(80);

    expect(toastMock).toHaveBeenCalled();
    expect(toastMock.mock.calls.at(-1)![0]).toBe("New version available");
    expect(pwaState()?.updateAvailable).toBe(true);
  });

  it("shows the Sonner toast on raw .md routes when the FAB is hidden", async () => {
    setPathname("/daily.md");
    respondVersion("build-b");
    const mod = await fresh();
    mod.registerAppUpdater();
    await flush(80);

    expect(toastMock).toHaveBeenCalled();
    expect(toastMock.mock.calls.at(-1)![0]).toBe("New version available");
  });

  it("dismisses the toast when syncing presentation onto a FAB-eligible route", async () => {
    setPathname("/note");
    respondVersion("build-b");
    const mod = await fresh();
    mod.registerAppUpdater();
    await flush(80);
    expect(toastMock).toHaveBeenCalled();
    toastMock.mockClear();
    dismissMock.mockClear();

    setPathname("/");
    window.__SNOTE_PWA_SYNC_UPDATE_UI__?.();
    expect(toastMock).not.toHaveBeenCalled();
    expect(dismissMock).toHaveBeenCalledWith("pwa-update-toast");
    expect(pwaState()?.updateAvailable).toBe(true);
  });

  it("sets updateAvailable from SW onNeedRefresh even when version.json matches the running build", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DEV", false);
    (window as unknown as { __SNOTE_E2E_ENABLE_PWA_UPDATE__?: boolean }).__SNOTE_E2E_ENABLE_PWA_UPDATE__ = false;
    // Production build id is the stamped `__BUILD_ID__` ("dev" in Vitest), not the E2E override.
    respondVersion("dev");
    installServiceWorkerHarness(async () => {});
    const mod = await fresh();
    mod.registerAppUpdater();
    const opts = registerSWMock.mock.calls[0][0];
    await opts.onNeedRefresh?.();

    expect(pwaState()?.updateAvailable).toBe(true);
    expect(toastMock).not.toHaveBeenCalled();
    expect(typeof window.__SNOTE_PWA_APPLY_UPDATE__).toBe("function");

    await vi.advanceTimersByTimeAsync(4000);
    expect(pwaState()?.updateAvailable).toBe(true);
    expect(pwaState()?.currentBuildId).toBe("dev");
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("does not persist pending-build=unknown when applying before version.json returns", async () => {
    vi.stubEnv("DEV", false);
    (window as unknown as { __SNOTE_E2E_ENABLE_PWA_UPDATE__?: boolean }).__SNOTE_E2E_ENABLE_PWA_UPDATE__ = false;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
      () => new Promise(() => {}),
    ) as unknown as typeof fetch;
    installServiceWorkerHarness(async () => {});
    const mod = await fresh();
    mod.registerAppUpdater();
    registerSWMock.mock.calls[0][0].onNeedRefresh?.();

    expect(pwaState()?.updateAvailable).toBe(true);
    const navigationWarning = silenceJsdomReloadWarning();
    window.__SNOTE_PWA_APPLY_UPDATE__?.();
    navigationWarning.mockRestore();

    expect(sessionStorage.getItem("pwa-update-pending-build")).not.toBe("unknown");
    expect(sessionStorage.getItem("pwa-update-pending-build")).toBeNull();
    expect(pwaState()?.pendingBuildId).not.toBe("unknown");
  });

  it("shows the Sonner toast from SW onNeedRefresh on /note", async () => {
    setPathname("/note");
    vi.stubEnv("DEV", false);
    (window as unknown as { __SNOTE_E2E_ENABLE_PWA_UPDATE__?: boolean }).__SNOTE_E2E_ENABLE_PWA_UPDATE__ = false;
    respondVersion("dev");
    installServiceWorkerHarness(async () => {});
    const mod = await fresh();
    mod.registerAppUpdater();
    await registerSWMock.mock.calls[0][0].onNeedRefresh?.();

    expect(pwaState()?.updateAvailable).toBe(true);
    expect(toastMock).toHaveBeenCalled();
    expect(toastMock.mock.calls.at(-1)![0]).toBe("New version available");
  });

  it("FAB apply and toast Update share __SNOTE_PWA_APPLY_UPDATE__", async () => {
    setPathname("/note");
    respondVersion("build-b");
    const mod = await fresh();
    mod.registerAppUpdater();
    await flush(80);

    const fromToast = toastMock.mock.calls.at(-1)![1] as {
      action: { props: { onClick: (e: Event) => void } };
    };
    expect(typeof window.__SNOTE_PWA_APPLY_UPDATE__).toBe("function");
    fromToast.action.props.onClick({ preventDefault: () => {} } as unknown as Event);
    expect(pwaState()?.reloadAttemptCount).toBe(1);

    window.__SNOTE_PWA_APPLY_UPDATE__?.();
    expect(pwaState()?.reloadAttemptCount).toBe(1);
  });

  it("does not append site-data cleanup copy while the update is pending", async () => {
    setPathname("/note");
    respondVersion("build-b");
    const mod = await fresh();
    mod.registerAppUpdater();
    await flush(80);

    clickToastAction();

    const lastOpts = toastMock.mock.calls.at(-1)![1] as { description: unknown };
    const serialized = JSON.stringify(lastOpts.description);
    expect(serialized).toContain("Applying the update.");
    expect(serialized).not.toContain("clear this site's data/cookies");
    expect(serialized).not.toContain("update.fallback_cleanup");
  });
});
