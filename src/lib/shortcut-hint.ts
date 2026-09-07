/** Platform-correct modifier labels for shortcut hints in the SPA chrome. */

export type NavigatorHints = {
  platform?: string;
  userAgent?: string;
};

function isApplePlatform(nav: NavigatorHints = typeof navigator === "undefined" ? {} : navigator): boolean {
  return /Mac|iPhone|iPad|iPod/.test(nav.platform ?? "");
}

export function modKeyLabel(nav?: NavigatorHints): "⌘" | "Ctrl" {
  return isApplePlatform(nav ?? (typeof navigator === "undefined" ? {} : navigator)) ? "⌘" : "Ctrl";
}

/** Compact chord shared by tooltips, Home hints, and the Shortcuts panel. */
export function formatModShortcut(keys: readonly string[], nav?: NavigatorHints): string {
  const mod = modKeyLabel(nav);
  if (mod === "⌘") {
    return `⌘${keys.map((key) => (key === "Shift" ? "⇧" : key)).join("")}`;
  }
  return ["Ctrl", ...keys].join("+");
}
