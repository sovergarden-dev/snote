import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { DonateButton } from "@/components/DonateButton";
import { I18nProvider } from "@/i18n/provider";
import { STORAGE_KEY } from "@/i18n";
import { dict } from "@/i18n/catalog";
import { PWA_UPDATE_STATE_EVENT } from "@/lib/pwa-update-readiness";
import tailwindConfig from "../../../tailwind.config";

const KOFI = "https://ko-fi.com/sovergarden";

type PwaWindowState = NonNullable<Window["__SNOTE_PWA_UPDATE_STATE__"]>;

function renderFab(path = "/") {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[path]}>
        <DonateButton />
      </MemoryRouter>
    </I18nProvider>,
  );
}

function setPwaState(partial: Partial<PwaWindowState>): void {
  window.__SNOTE_PWA_UPDATE_STATE__ = {
    currentBuildId: "build-a",
    pendingBuildId: null,
    updateAvailable: false,
    updateInProgress: false,
    reloadAttemptCount: 0,
    reloadStrategy: null,
    lastRemoteBuildId: null,
    lastAcceptedAt: null,
    ...partial,
  };
  window.dispatchEvent(new Event(PWA_UPDATE_STATE_EVENT));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(STORAGE_KEY, "en");
  window.__SNOTE_PWA_UPDATE_STATE__ = undefined;
  window.__SNOTE_PWA_APPLY_UPDATE__ = undefined;
});

afterEach(() => {
  cleanup();
  window.__SNOTE_PWA_UPDATE_STATE__ = undefined;
  window.__SNOTE_PWA_APPLY_UPDATE__ = undefined;
});

describe("DonateButton — idle Ko-fi FAB", () => {
  it("opens Ko-fi in a new tab and keeps a ring + soft pulse", () => {
    renderFab();
    const link = screen.getByRole("link", { name: dict.en["fab.donate.aria"] });
    expect(link).toHaveAttribute("href", KOFI);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link.className).toMatch(/border-border/);
    expect(link.className).toMatch(/animate-heartbeat/);
    expect(link.className).toMatch(/motion-reduce:animate-none/);
    expect(link.className).toMatch(/h-11/);
    expect(link.className).toMatch(/w-11/);
    expect(link.className).toMatch(/bottom-20/);
  });

  it("hides on /note and raw .md routes", () => {
    const { unmount } = renderFab("/note");
    expect(screen.queryByRole("link")).toBeNull();
    unmount();
    renderFab("/daily.md");
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("DonateButton — update available", () => {
  it("does not open Ko-fi on the primary click; applies the update only", async () => {
    const apply = vi.fn();
    window.__SNOTE_PWA_APPLY_UPDATE__ = apply;
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });

    const user = userEvent.setup();
    const updateBtn = screen.getByRole("button", { name: dict.en["fab.update.aria"] });
    expect(updateBtn.closest("a")).toBeNull();
    await user.click(updateBtn);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("keeps a short NEW/↑ badge, not long New Version copy, with a locale aria-label", () => {
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });

    expect(screen.getByText(dict.en["fab.update.badge"])).toBeInTheDocument();
    expect(dict.en["fab.update.badge"].toLowerCase()).not.toContain("version");
    expect(screen.queryByText(/^New Version$/i)).toBeNull();
    expect(screen.getByRole("button", { name: dict.en["fab.update.aria"] })).toBeInTheDocument();
    const badge = screen.getByText(dict.en["fab.update.badge"]);
    expect(badge.getAttribute("aria-hidden")).toBe("true");
  });

  it("announces via role=status live region when the update chrome appears", () => {
    renderFab();
    expect(screen.queryByRole("status")).toBeNull();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent(dict.en["fab.update.aria"]);
  });

  it("drops the decorative ring, pulses stronger, and scales with transform only (no layout push)", () => {
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });
    const updateBtn = screen.getByRole("button", { name: dict.en["fab.update.aria"] });
    expect(updateBtn.className).not.toMatch(/border-border/);
    expect(updateBtn.className).toMatch(/animate-heartbeat-update/);
    expect(updateBtn.className).toMatch(/motion-reduce:animate-none/);
    expect(updateBtn.className).toMatch(/h-11/);
    expect(updateBtn.className).toMatch(/w-11/);
    const host = updateBtn.parentElement;
    expect(host?.className).toMatch(/h-11/);
    expect(host?.className).toMatch(/w-11/);
    expect(host?.className).toMatch(/bottom-20/);
  });

  it("offers a secondary Ko-fi heart that does not share the update click", async () => {
    const apply = vi.fn();
    window.__SNOTE_PWA_APPLY_UPDATE__ = apply;
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });
    expect(screen.getByRole("button", { name: dict.en["fab.update.aria"] })).toBeInTheDocument();
    const kofi = screen.getByRole("link", { name: dict.en["fab.donate.aria"] });
    expect(kofi).toHaveAttribute("href", KOFI);
    expect(kofi).toHaveAttribute("target", "_blank");
    const user = userEvent.setup();
    await user.click(kofi);
    expect(apply).not.toHaveBeenCalled();
  });

  it("still shows update chrome when updateAvailable has no pendingBuildId", () => {
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: null });
    });
    expect(screen.getByRole("button", { name: dict.en["fab.update.aria"] })).toBeInTheDocument();
  });

  it("keeps a 44px hit on a visually smaller secondary heart", () => {
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });
    const kofi = screen.getByRole("link", { name: dict.en["fab.donate.aria"] });
    expect(kofi.className).toMatch(/h-11/);
    expect(kofi.className).toMatch(/w-11/);
    expect(kofi.querySelector(".h-7.w-7")).not.toBeNull();
  });

  it("snoozes this occurrence so the FAB returns to idle Ko-fi", async () => {
    const apply = vi.fn();
    window.__SNOTE_PWA_APPLY_UPDATE__ = apply;
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: dict.en["fab.update.snooze_aria"] }));

    expect(sessionStorage.getItem("pwa-fab-snooze")).toBe("build-b");
    expect(screen.queryByRole("button", { name: dict.en["fab.update.aria"] })).toBeNull();
    expect(screen.getByRole("link", { name: dict.en["fab.donate.aria"] })).toHaveAttribute("href", KOFI);
    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });
    expect(screen.queryByRole("button", { name: dict.en["fab.update.aria"] })).toBeNull();

    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-c" });
    });
    expect(screen.getByRole("button", { name: dict.en["fab.update.aria"] })).toBeInTheDocument();
  });

  it("uses the localized badge and aria-label", async () => {
    localStorage.setItem(STORAGE_KEY, "zh");
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });
    expect(
      await screen.findByRole("button", { name: dict.zh["fab.update.aria"] }),
    ).toBeInTheDocument();
    expect(screen.getByText(dict.zh["fab.update.badge"])).toBeInTheDocument();
  });
});

describe("DonateButton — Pixel contracts", () => {
  it("keeps heartbeat-update scale at or below 2.5×", () => {
    const frames = tailwindConfig.theme.extend.keyframes["heartbeat-update"];
    expect(frames).toBeDefined();
    const scales = JSON.stringify(frames).match(/scale\(([\d.]+)\)/g) ?? [];
    expect(scales.length).toBeGreaterThan(0);
    for (const token of scales) {
      const value = Number(token.slice("scale(".length, -1));
      expect(value).toBeLessThanOrEqual(2.5);
    }
  });

  it("does not stuff long New Version into any locale badge", () => {
    for (const lang of Object.keys(dict) as Array<keyof typeof dict>) {
      const badge = dict[lang]["fab.update.badge"];
      expect(badge.length, lang).toBeLessThanOrEqual(4);
      expect(badge.toLowerCase(), lang).not.toContain("version");
    }
  });

  it("places the PWA sonner toaster at top-right so it does not cover the FAB", () => {
    const src = readFileSync(resolve(__dirname, "../ui/sonner.tsx"), "utf8");
    expect(src).toMatch(/position="top-right"/);
  });
});

describe("DonateButton — snooze control copy", () => {
  it("exposes Later via the snooze control", () => {
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });
    const snooze = screen.getByRole("button", { name: dict.en["fab.update.snooze_aria"] });
    expect(within(snooze).getByText(dict.en["fab.update.snooze"])).toBeInTheDocument();
  });
});
