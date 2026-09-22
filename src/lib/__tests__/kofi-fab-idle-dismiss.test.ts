import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KOFI_FAB_IDLE_DISMISS_KEY,
  KOFI_FAB_IDLE_DISMISS_MS,
  dismissIdleFab,
  isIdleDismissed,
  readIdleDismissUntil,
  writeIdleDismissUntil,
} from "@/lib/kofi-fab-idle-dismiss";

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("kofi-fab-idle-dismiss storage", () => {
  it("uses a dedicated localStorage until-key and a 24h duration", () => {
    expect(KOFI_FAB_IDLE_DISMISS_KEY).toBe("kofi-fab-idle-dismiss-until");
    expect(KOFI_FAB_IDLE_DISMISS_MS).toBe(24 * 60 * 60 * 1000);
    expect(KOFI_FAB_IDLE_DISMISS_KEY).not.toBe("pwa-fab-snooze");
  });

  it("writes a decimal epoch-ms until timestamp and reads it back", () => {
    const until = NOW + KOFI_FAB_IDLE_DISMISS_MS;
    expect(writeIdleDismissUntil(until)).toBe(true);
    expect(localStorage.getItem(KOFI_FAB_IDLE_DISMISS_KEY)).toBe(String(until));
    expect(sessionStorage.getItem("pwa-fab-snooze")).toBeNull();
    expect(readIdleDismissUntil()).toBe(until);
    expect(isIdleDismissed(readIdleDismissUntil(), NOW)).toBe(true);
  });

  it("dismissIdleFab persists now+24h and does not touch the update snooze key", () => {
    const result = dismissIdleFab();
    expect(result.until).toBe(NOW + KOFI_FAB_IDLE_DISMISS_MS);
    expect(result.persisted).toBe(true);
    expect(localStorage.getItem(KOFI_FAB_IDLE_DISMISS_KEY)).toBe(String(result.until));
    expect(sessionStorage.getItem("pwa-fab-snooze")).toBeNull();
    expect(sessionStorage.getItem(KOFI_FAB_IDLE_DISMISS_KEY)).toBeNull();
  });

  it("treats missing, corrupt, and non-finite keys as not dismissed", () => {
    expect(readIdleDismissUntil()).toBeNull();
    expect(isIdleDismissed(null, NOW)).toBe(false);

    localStorage.setItem(KOFI_FAB_IDLE_DISMISS_KEY, "not-a-number");
    expect(readIdleDismissUntil()).toBeNull();

    localStorage.setItem(KOFI_FAB_IDLE_DISMISS_KEY, "NaN");
    expect(readIdleDismissUntil()).toBeNull();

    localStorage.setItem(KOFI_FAB_IDLE_DISMISS_KEY, "Infinity");
    expect(readIdleDismissUntil()).toBeNull();

    localStorage.setItem(KOFI_FAB_IDLE_DISMISS_KEY, "");
    expect(readIdleDismissUntil()).toBeNull();
  });

  it("shows idle again once the until timestamp has passed", () => {
    const until = NOW - 1;
    writeIdleDismissUntil(until);
    expect(isIdleDismissed(readIdleDismissUntil(), NOW)).toBe(false);
  });

  it("returns persisted=false on write failure without throwing", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(writeIdleDismissUntil(NOW + KOFI_FAB_IDLE_DISMISS_MS)).toBe(false);
    expect(dismissIdleFab()).toEqual({
      until: NOW + KOFI_FAB_IDLE_DISMISS_MS,
      persisted: false,
    });
  });

  it("returns null on read failure without throwing", () => {
    localStorage.setItem(KOFI_FAB_IDLE_DISMISS_KEY, String(NOW + 1));
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readIdleDismissUntil()).toBeNull();
  });
});
