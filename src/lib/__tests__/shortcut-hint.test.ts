import { describe, expect, it } from "vitest";
import { formatModShortcut, modKeyLabel } from "../shortcut-hint";

describe("shortcut-hint", () => {
  it("shows Ctrl+K / Ctrl+P on Windows and Linux", () => {
    for (const platform of ["Win32", "Linux x86_64"]) {
      const nav = { platform };
      expect(modKeyLabel(nav)).toBe("Ctrl");
      expect(formatModShortcut(["K"], nav)).toBe("Ctrl+K");
      expect(formatModShortcut(["P"], nav)).toBe("Ctrl+P");
    }
  });

  it("shows ⌘K / ⌘P on Mac", () => {
    const nav = { platform: "MacIntel" };
    expect(modKeyLabel(nav)).toBe("⌘");
    expect(formatModShortcut(["K"], nav)).toBe("⌘K");
    expect(formatModShortcut(["P"], nav)).toBe("⌘P");
  });

  it("matches outline toggle wording between tooltip and shortcuts panel", () => {
    expect(formatModShortcut(["\\"], { platform: "Win32" })).toBe("Ctrl+\\");
    expect(formatModShortcut(["\\"], { platform: "MacIntel" })).toBe("⌘\\");
  });
});
