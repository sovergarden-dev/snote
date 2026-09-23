import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const INDEX_CSS = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
const EDITOR = readFileSync(resolve(__dirname, "../../components/note/Editor.tsx"), "utf8");
const NOTE_PAGE = readFileSync(resolve(__dirname, "../../pages/NotePage.tsx"), "utf8");

function ruleBodies(css: string, needle: string): string[] {
  const bodies: string[] = [];
  const re = /([^{}@][^{]*)\{([^}]*)\}/g;
  for (const match of css.matchAll(re)) {
    const selectors = match[1].split(",").map((part) => part.trim().replace(/\s+/g, " "));
    if (selectors.some((selector) => selector === needle || selector.endsWith(" " + needle))) {
      bodies.push(match[2]);
    }
  }
  return bodies;
}

describe("editor scroll feel (typewriter OFF) — nested overflow", () => {
  it("B1/B2: Editor host clips instead of becoming a second scroller", () => {
    expect(NOTE_PAGE).toMatch(/className="h-full min-h-0 overflow-hidden"/);
    expect(NOTE_PAGE).not.toMatch(/className="h-full overflow-auto"/);
  });

  it("keeps the editor pane shrinkable (min-h-0) so .cm-scroller is the only overflow", () => {
    expect(NOTE_PAGE).not.toMatch(/: "flex-1 min-w-0"/);
    expect(NOTE_PAGE.match(/flex-1 min-h-0 min-w-0/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("B3: keeps ~24px top/bottom breathing plus --snote-search-gutter", () => {
    expect(EDITOR).toMatch(/paddingTop:\s*"calc\(24px \+ var\(--snote-search-gutter, 0px\)\)"/);
    expect(EDITOR).toMatch(/paddingBottom:\s*"24px"/);
    expect(INDEX_CSS).toMatch(/--snote-search-gutter:\s*52px/);
    expect(INDEX_CSS).toMatch(/--snote-search-gutter:\s*92px/);
  });

  it("B4: typewriter ON still uses ~45vh ends", () => {
    expect(INDEX_CSS).toMatch(/html\.typewriter-mode \.cm-scroller\s*\{[^}]*padding-top:\s*45vh\s*!important/);
    expect(INDEX_CSS).toMatch(/html\.typewriter-mode \.cm-scroller\s*\{[^}]*padding-bottom:\s*45vh\s*!important/);
  });

  it("B5: does not reintroduce scroll hijack or scroller layer promotion", () => {
    const scrollerBodies = ruleBodies(INDEX_CSS, ".cm-scroller").join("\n");
    expect(scrollerBodies).not.toMatch(/will-change:\s*scroll-position/);
    expect(scrollerBodies).not.toMatch(/transform:/);
    expect(EDITOR).not.toMatch(/addEventListener\(\s*["']wheel["']/);
  });

  it("B8: keeps overscroll-behavior: contain (not the rubber-band root cause)", () => {
    expect(INDEX_CSS).toMatch(/\.cm-scroller\s*\{[^}]*overscroll-behavior:\s*contain/);
  });

  it("B6: honors prefers-reduced-motion on the scroller", () => {
    expect(INDEX_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.cm-scroller\s*\{[^}]*-webkit-overflow-scrolling:\s*auto/,
    );
  });
});
