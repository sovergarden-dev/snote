import type { ReactElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportMenu } from "@/components/note/topbar/ExportMenu";
import { ModeMenu } from "@/components/note/topbar/ModeMenu";
import { I18nProvider } from "@/i18n/provider";
import { STORAGE_KEY } from "@/i18n";

vi.mock("@/hooks/use-eink", () => ({
  useEink: () => ({ pref: "auto", setMode: vi.fn() }),
}));
vi.mock("@/hooks/use-vim-mode", () => ({
  useVimMode: () => ({ vim: false, toggleVim: vi.fn() }),
}));
vi.mock("@/hooks/use-toast", () => ({
  toast: vi.fn(),
  useToast: () => ({ toast: vi.fn(), dismiss: () => {}, toasts: [] }),
}));

const INDEX_CSS = resolve(__dirname, "../../../../index.css");
const DROPDOWN_SRC = resolve(__dirname, "../../../ui/dropdown-menu.tsx");
const TOPBAR_BRAND_SRC = resolve(__dirname, "../TopbarBrand.tsx");

function wrap(ui: ReactElement) {
  localStorage.setItem(STORAGE_KEY, "en");
  return render(<I18nProvider>{ui}</I18nProvider>);
}

function layerBody(css: string, name: string): string | null {
  const startTok = `@layer ${name}`;
  const start = css.indexOf(startTok);
  if (start < 0) return null;
  const brace = css.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(brace + 1, i);
    }
  }
  return null;
}

function hslChannels(raw: string): [number, number, number] {
  const match = raw.trim().match(/^(-?[\d.]+)\s+(-?[\d.]+)%\s+(-?[\d.]+)%$/);
  if (!match) throw new Error(`not hsl channels: ${raw}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return light - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return [f(0), f(8), f(4)];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`missing --${name}`);
  return match[1];
}

describe("Mode / Export menus are opaque", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(STORAGE_KEY, "en");
  });

  afterEach(() => cleanup());

  it("paints Mode menu with an opaque surface", async () => {
    const user = userEvent.setup();
    wrap(
      <ModeMenu
        zen={false}
        onToggleZen={() => {}}
        typewriter={false}
        onToggleTypewriter={() => {}}
        focusLine={false}
        onToggleFocusLine={() => {}}
        paginated={false}
        onTogglePagination={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^Mode/ }));
    const menu = screen.getByRole("menu");
    expect(menu).toHaveClass("chrome-menu-surface");
    expect(menu).toHaveClass("text-popover-foreground");
    expect(menu).toHaveClass("opacity-100");
    expect(menu.className).not.toMatch(/fade-in-0/);
    expect(menu.className).not.toMatch(/bg-popover\//);
  });

  it("paints Export menu with an opaque surface", async () => {
    const user = userEvent.setup();
    wrap(
      <ExportMenu slug="demo" getContent={() => "# hi"} isEncrypted={false} />,
    );
    await user.click(screen.getByRole("button", { name: /^Export/ }));
    const menu = screen.getByRole("menu");
    expect(menu).toHaveClass("chrome-menu-surface");
    expect(menu).toHaveClass("text-popover-foreground");
    expect(menu).toHaveClass("opacity-100");
    expect(menu.className).not.toMatch(/fade-in-0/);
    expect(menu.className).not.toMatch(/bg-popover\//);
  });
});

describe("H2 opaque chrome cascade", () => {
  it("keeps chrome-menu-surface unlayered so production CSS flatten cannot lose to bg-popover", () => {
    const css = readFileSync(INDEX_CSS, "utf8");
    for (const name of ["base", "components", "utilities"]) {
      const body = layerBody(css, name);
      if (body) expect(body, `@layer ${name}`).not.toMatch(/\.chrome-menu-surface\s*\{/);
    }
    expect(css).toMatch(
      /\.chrome-menu-surface\s*\{[^}]*background-color:\s*hsl\(var\(--popover\)\s*\/\s*1\)/,
    );
    expect(css).toMatch(/\.chrome-menu-surface\s*\{[^}]*opacity:\s*1/);
    expect(css.indexOf(".chrome-menu-surface")).toBeGreaterThan(css.indexOf("@tailwind utilities"));
  });

  it("popover fill vs label text meets 4.5:1 in light and dark tokens", () => {
    const css = readFileSync(INDEX_CSS, "utf8");
    const root = layerBody(css, "base") ?? css;
    const light = root.slice(root.indexOf(":root"), root.indexOf(".dark"));
    const dark = root.slice(root.indexOf(".dark"));
    for (const block of [light, dark]) {
      const bg = hslToRgb(...hslChannels(token(block, "popover")));
      const fg = hslToRgb(...hslChannels(token(block, "popover-foreground")));
      expect(contrastRatio(bg, fg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("does not fade dropdown surfaces in from opacity 0", () => {
    const src = readFileSync(DROPDOWN_SRC, "utf8");
    expect(src).not.toMatch(/fade-in-0/);
    expect(src).not.toMatch(/fade-out-0/);
    expect(src).toMatch(/opacity-100/);
    expect(src).toMatch(/zIndex:\s*50/);
  });
});

describe("H4 Outline tooltip chord", () => {
  it("uses the same formatModShortcut helper as the Shortcuts panel", () => {
    const src = readFileSync(TOPBAR_BRAND_SRC, "utf8");
    expect(src).toContain('formatModShortcut(["\\\\"])');
  });
});
