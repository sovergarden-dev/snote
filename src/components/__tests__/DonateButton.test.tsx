import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { DonateButton } from "@/components/DonateButton";
import { I18nProvider } from "@/i18n/provider";
import { STORAGE_KEY } from "@/i18n";
import { dict } from "@/i18n/catalog";
import {
  KOFI_FAB_IDLE_DISMISS_KEY,
  KOFI_FAB_IDLE_DISMISS_MS,
} from "@/lib/kofi-fab-idle-dismiss";
import { PWA_UPDATE_STATE_EVENT } from "@/lib/pwa-update-readiness";
import tailwindConfig from "../../../tailwind.config";

const KOFI = "https://ko-fi.com/sovergarden";
const INDEX_CSS = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

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

function keyframeScales(name: "heartbeat" | "heartbeat-update"): number[] {
  const frames = tailwindConfig.theme.extend.keyframes[name];
  const scales = JSON.stringify(frames).match(/scale\(([\d.]+)\)/g) ?? [];
  return scales.map((token) => Number(token.slice("scale(".length, -1)));
}

function futureIdleDismissUntil(): string {
  return String(Date.now() + KOFI_FAB_IDLE_DISMISS_MS);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(STORAGE_KEY, "en");
  window.__SNOTE_PWA_UPDATE_STATE__ = undefined;
  window.__SNOTE_PWA_APPLY_UPDATE__ = undefined;
  document.documentElement.removeAttribute("data-snote-fab-update");
  document.documentElement.removeAttribute("data-snote-fab-idle");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.__SNOTE_PWA_UPDATE_STATE__ = undefined;
  window.__SNOTE_PWA_APPLY_UPDATE__ = undefined;
  document.documentElement.removeAttribute("data-snote-fab-update");
  document.documentElement.removeAttribute("data-snote-fab-idle");
});

describe("DonateButton — idle Ko-fi FAB", () => {
  it("opens Ko-fi in a new tab and keeps a ring + soft pulse at the equal inset", () => {
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
    expect(link.className).toMatch(/snote-fab-anchor/);
    expect(link.className).not.toMatch(/bottom-20/);
    expect(document.documentElement).not.toHaveAttribute("data-snote-fab-update");
    expect(document.documentElement).toHaveAttribute("data-snote-fab-idle");
  });

  it("hides on /note and raw .md routes", () => {
    const { unmount } = renderFab("/note");
    expect(screen.queryByRole("link")).toBeNull();
    unmount();
    const slash = renderFab("/note/");
    expect(screen.queryByRole("link")).toBeNull();
    slash.unmount();
    renderFab("/daily.md");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("marks the idle FAB with data-donate-fab so the PWA presenter can suppress Sonner", () => {
    renderFab();
    expect(screen.getByRole("link", { name: dict.en["fab.donate.aria"] })).toHaveAttribute("data-donate-fab");
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

  it("shows a non-interactive status chip and no NEW/MỚI badge", () => {
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });

    const chip = screen.getByText(dict.en["fab.update.status"]);
    expect(chip.tagName).toBe("DIV");
    expect(chip).toHaveAttribute("aria-hidden", "true");
    expect(chip.className).toMatch(/pointer-events-none/);
    expect(chip.closest("button")).toBeNull();
    expect(chip.closest("a")).toBeNull();

    expect(screen.queryByText(/^NEW$/)).toBeNull();
    expect(screen.queryByText(/^MỚI$/)).toBeNull();
    expect(screen.queryByText(/^Later$/)).toBeNull();
    expect(screen.queryByText(/^Để sau$/)).toBeNull();

    const updateBtn = screen.getByRole("button", { name: dict.en["fab.update.aria"] });
    expect(updateBtn.querySelector("span[aria-hidden='true']")).toBeNull();
    expect(updateBtn.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
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
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
    expect(document.querySelector("[data-donate-fab]")).not.toBeNull();
  });

  it("uses a larger update disk, stronger pulse, transform-only scale, and equal inset", () => {
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });
    const updateBtn = screen.getByRole("button", { name: dict.en["fab.update.aria"] });
    expect(updateBtn.className).not.toMatch(/border-border/);
    expect(updateBtn.className).toMatch(/animate-heartbeat-update/);
    expect(updateBtn.className).toMatch(/motion-reduce:animate-none/);
    expect(updateBtn.className).toMatch(/h-14/);
    expect(updateBtn.className).toMatch(/w-14/);
    expect(updateBtn.querySelector(".h-7.w-7")).not.toBeNull();
    const host = updateBtn.parentElement;
    expect(host?.className).toMatch(/h-14/);
    expect(host?.className).toMatch(/w-14/);
    expect(host?.className).toMatch(/snote-fab-anchor/);
    expect(host?.className).not.toMatch(/bottom-20/);
    expect(document.documentElement).toHaveAttribute("data-snote-fab-update");
    expect(document.documentElement).not.toHaveAttribute("data-snote-fab-idle");
  });

  it("does not keep a Ko-fi satellite while update is showing", () => {
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });
    expect(screen.getByRole("button", { name: dict.en["fab.update.aria"] })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: dict.en["fab.donate.aria"] })).toBeNull();
  });

  it("still shows update chrome when updateAvailable has no pendingBuildId", () => {
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: null });
    });
    expect(screen.getByRole("button", { name: dict.en["fab.update.aria"] })).toBeInTheDocument();
  });

  it("keeps a 44px hit on a visually smaller snooze heart with a CSS strike", () => {
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });
    const snooze = screen.getByRole("button", { name: dict.en["fab.update.snooze_aria"] });
    expect(snooze.className).toMatch(/h-11/);
    expect(snooze.className).toMatch(/w-11/);
    expect(snooze.className).toMatch(/fab-snooze-hit/);
    expect(snooze.querySelector(".h-7.w-7")).not.toBeNull();
    expect(snooze.querySelector(".fab-snooze-strike")).not.toBeNull();
    expect(snooze.className).toMatch(/focus-visible:ring-2/);
  });

  it("snoozes this occurrence from the small heart so the FAB returns to idle Ko-fi", async () => {
    const apply = vi.fn();
    window.__SNOTE_PWA_APPLY_UPDATE__ = apply;
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });
    const user = userEvent.setup();
    const snooze = screen.getByRole("button", { name: dict.en["fab.update.snooze_aria"] });
    expect(snooze.querySelector("svg")).not.toBeNull();
    await user.click(snooze);

    expect(sessionStorage.getItem("pwa-fab-snooze")).toBe("build-b");
    expect(screen.queryByRole("button", { name: dict.en["fab.update.aria"] })).toBeNull();
    expect(screen.queryByText(dict.en["fab.update.status"])).toBeNull();
    expect(screen.getByRole("link", { name: dict.en["fab.donate.aria"] })).toHaveAttribute("href", KOFI);
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.documentElement).not.toHaveAttribute("data-snote-fab-update");
    expect(document.documentElement).toHaveAttribute("data-snote-fab-idle");

    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });
    expect(screen.queryByRole("button", { name: dict.en["fab.update.aria"] })).toBeNull();

    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-c" });
    });
    expect(screen.getByRole("button", { name: dict.en["fab.update.aria"] })).toBeInTheDocument();
  });

  it("uses the localized status chip and aria-label", async () => {
    localStorage.setItem(STORAGE_KEY, "zh");
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });
    expect(
      await screen.findByRole("button", { name: dict.zh["fab.update.aria"] }),
    ).toBeInTheDocument();
    expect(screen.getByText(dict.zh["fab.update.status"])).toBeInTheDocument();
  });
});

describe("DonateButton — idle dismiss 24h", () => {
  it("on idle click opens Ko-fi and writes dismissUntil = now+24h then hides immediately", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderFab();
    const user = userEvent.setup();
    const link = screen.getByRole("link", { name: dict.en["fab.donate.aria"] });
    const before = Date.now();
    await user.click(link);

    expect(open).toHaveBeenCalledWith(KOFI, "_blank", "noopener,noreferrer");
    const until = Number(localStorage.getItem(KOFI_FAB_IDLE_DISMISS_KEY));
    expect(until).toBeGreaterThanOrEqual(before + KOFI_FAB_IDLE_DISMISS_MS);
    expect(until).toBeLessThanOrEqual(Date.now() + KOFI_FAB_IDLE_DISMISS_MS);
    expect(sessionStorage.getItem("pwa-fab-snooze")).toBeNull();
    expect(screen.queryByRole("link", { name: dict.en["fab.donate.aria"] })).toBeNull();
    expect(document.querySelector("[data-donate-fab]")).toBeNull();
    expect(document.documentElement).not.toHaveAttribute("data-snote-fab-idle");
    expect(document.documentElement).not.toHaveAttribute("data-snote-fab-update");
  });

  it("hides idle FAB when a future until-key is already stored", () => {
    localStorage.setItem(KOFI_FAB_IDLE_DISMISS_KEY, futureIdleDismissUntil());
    renderFab();
    expect(screen.queryByRole("link", { name: dict.en["fab.donate.aria"] })).toBeNull();
    expect(document.documentElement).not.toHaveAttribute("data-snote-fab-idle");
  });

  it("shows idle FAB when the until-key is missing or corrupt", () => {
    localStorage.setItem(KOFI_FAB_IDLE_DISMISS_KEY, "nope");
    const { unmount } = renderFab();
    expect(screen.getByRole("link", { name: dict.en["fab.donate.aria"] })).toBeInTheDocument();
    unmount();

    localStorage.removeItem(KOFI_FAB_IDLE_DISMISS_KEY);
    renderFab();
    expect(screen.getByRole("link", { name: dict.en["fab.donate.aria"] })).toBeInTheDocument();
  });

  it("still shows the #153 update cluster while idle dismiss is active", () => {
    localStorage.setItem(KOFI_FAB_IDLE_DISMISS_KEY, futureIdleDismissUntil());
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });

    expect(screen.getByRole("button", { name: dict.en["fab.update.aria"] })).toBeInTheDocument();
    expect(screen.getByText(dict.en["fab.update.status"])).toBeInTheDocument();
    expect(screen.getByRole("button", { name: dict.en["fab.update.snooze_aria"] })).toBeInTheDocument();
    expect(screen.queryByText(/^MỚI$/)).toBeNull();
    expect(screen.queryByRole("link", { name: dict.en["fab.donate.aria"] })).toBeNull();
    expect(document.documentElement).toHaveAttribute("data-snote-fab-update");
    expect(document.documentElement).not.toHaveAttribute("data-snote-fab-idle");
    expect(sessionStorage.getItem("pwa-fab-snooze")).toBeNull();
  });

  it("stays dismissed after update snooze when still inside the idle window", async () => {
    const until = futureIdleDismissUntil();
    localStorage.setItem(KOFI_FAB_IDLE_DISMISS_KEY, until);
    renderFab();
    act(() => {
      setPwaState({ updateAvailable: true, pendingBuildId: "build-b" });
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: dict.en["fab.update.snooze_aria"] }));

    expect(sessionStorage.getItem("pwa-fab-snooze")).toBe("build-b");
    expect(localStorage.getItem(KOFI_FAB_IDLE_DISMISS_KEY)).toBe(until);
    expect(screen.queryByRole("button", { name: dict.en["fab.update.aria"] })).toBeNull();
    expect(screen.queryByRole("link", { name: dict.en["fab.donate.aria"] })).toBeNull();
    expect(document.documentElement).not.toHaveAttribute("data-snote-fab-idle");
    expect(document.documentElement).not.toHaveAttribute("data-snote-fab-update");
  });

  it("opens Ko-fi and hides in-memory when localStorage write fails", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key) => {
      if (key === KOFI_FAB_IDLE_DISMISS_KEY) throw new Error("quota");
      return undefined;
    });
    renderFab();
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: dict.en["fab.donate.aria"] }));

    expect(open).toHaveBeenCalledWith(KOFI, "_blank", "noopener,noreferrer");
    expect(screen.queryByRole("link", { name: dict.en["fab.donate.aria"] })).toBeNull();
    expect(document.documentElement).not.toHaveAttribute("data-snote-fab-idle");
  });

  it("does not change dismiss storage when zen-hide routes suppress the FAB", () => {
    const until = futureIdleDismissUntil();
    localStorage.setItem(KOFI_FAB_IDLE_DISMISS_KEY, until);
    renderFab("/note");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: dict.en["fab.update.aria"] })).toBeNull();
    expect(localStorage.getItem(KOFI_FAB_IDLE_DISMISS_KEY)).toBe(until);
    expect(document.documentElement).not.toHaveAttribute("data-snote-fab-idle");
  });
});

describe("DonateButton — Pixel contracts", () => {
  it("keeps heartbeat-update stronger than idle and within the 1.18–1.22 peak lock", () => {
    const idle = keyframeScales("heartbeat");
    const update = keyframeScales("heartbeat-update");
    expect(idle.length).toBeGreaterThan(0);
    expect(update.length).toBeGreaterThan(0);
    const idlePeak = Math.max(...idle);
    const updatePeak = Math.max(...update);
    expect(updatePeak).toBeGreaterThan(idlePeak);
    expect(updatePeak).toBeGreaterThanOrEqual(1.18);
    expect(updatePeak).toBeLessThanOrEqual(1.22);
    for (const value of update) {
      expect(value).toBeLessThanOrEqual(2.5);
    }

    const idleAnim = tailwindConfig.theme.extend.animation.heartbeat;
    const updateAnim = tailwindConfig.theme.extend.animation["heartbeat-update"];
    const idleMs = Number(/([\d.]+)s/.exec(idleAnim)?.[1]);
    const updateMs = Number(/([\d.]+)s/.exec(updateAnim)?.[1]);
    expect(updateMs).toBeLessThan(idleMs);
  });

  it("anchors FAB inset at 1rem plus safe-area and sizes PageIndicator from the primary disk", () => {
    expect(INDEX_CSS).toMatch(/--snote-fab-inset:\s*1rem/);
    expect(INDEX_CSS).toMatch(/--snote-fab-idle-disk:\s*2\.75rem/);
    expect(INDEX_CSS).toMatch(/--snote-fab-update-disk:\s*3\.5rem/);
    expect(INDEX_CSS).toMatch(/--snote-fab-gap:\s*0\.5rem/);
    expect(INDEX_CSS).toMatch(/html\[data-snote-fab-update\]/);
    expect(INDEX_CSS).toMatch(/html\[data-snote-fab-idle\]/);
    expect(INDEX_CSS).toMatch(/\.snote-fab-anchor/);
    expect(INDEX_CSS).toMatch(/\.snote-page-indicator/);
    expect(INDEX_CSS).toMatch(/--snote-fab-primary-disk/);
    expect(INDEX_CSS).toMatch(/html\.zen-mode[\s\S]*--snote-fab-primary-disk:\s*0rem/);
    expect(INDEX_CSS).toMatch(
      /html:not\(\[data-snote-fab-idle\]\):not\(\[data-snote-fab-update\]\)[\s\S]*--snote-fab-primary-disk:\s*0rem/,
    );
    expect(INDEX_CSS).toMatch(
      /html:not\(\[data-snote-fab-idle\]\):not\(\[data-snote-fab-update\]\)[\s\S]*--snote-fab-gap:\s*0rem/,
    );
  });

  it("draws a diagonal snooze strike on hover/focus without a new icon asset", () => {
    expect(INDEX_CSS).toMatch(/\.fab-snooze-hit:hover \.fab-snooze-strike::after/);
    expect(INDEX_CSS).toMatch(/\.fab-snooze-hit:focus-visible \.fab-snooze-strike::after/);
    expect(INDEX_CSS).toMatch(/to bottom right/);
    expect(INDEX_CSS).toMatch(/opacity:\s*0\.75/);
  });

  it("keeps the fallback toaster at top-right for FAB-hidden routes", () => {
    const src = readFileSync(resolve(__dirname, "../ui/sonner.tsx"), "utf8");
    expect(src).toMatch(/position="top-right"/);
  });
});
