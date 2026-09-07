import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ShortcutHelp } from "@/components/ShortcutHelp";
import { I18nProvider } from "@/i18n/provider";
import { STORAGE_KEY } from "@/i18n";
import { formatModShortcut } from "@/lib/shortcut-hint";

function renderHelp() {
  localStorage.setItem(STORAGE_KEY, "en");
  return render(
    <I18nProvider>
      <ShortcutHelp open onOpenChange={() => {}} />
    </I18nProvider>,
  );
}

function stubPlatform(platform: string) {
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
}

describe("ShortcutHelp platform hints", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("uses Ctrl chords on Windows", () => {
    stubPlatform("Win32");
    renderHelp();
    expect(screen.getAllByText("Ctrl").length).toBeGreaterThan(0);
    expect(screen.queryByText("⌘")).not.toBeInTheDocument();
  });

  it("uses ⌘ chords on Mac", () => {
    stubPlatform("MacIntel");
    renderHelp();
    expect(screen.getAllByText("⌘").length).toBeGreaterThan(0);
  });

  it("keeps an opaque panel surface", () => {
    stubPlatform("Linux x86_64");
    renderHelp();
    expect(screen.getByRole("dialog")).toHaveClass("chrome-menu-surface");
  });

  it("lists the same outline chord the tooltip helper produces", () => {
    stubPlatform("Win32");
    renderHelp();
    expect(formatModShortcut(["\\"], { platform: "Win32" })).toBe("Ctrl+\\");
    expect(screen.getAllByText("Ctrl").length).toBeGreaterThan(0);
    expect(screen.getByText("\\")).toBeInTheDocument();
  });
});
