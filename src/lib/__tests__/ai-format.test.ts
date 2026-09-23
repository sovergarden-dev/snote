import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ZERO_WIDTH_CHARS,
  approxTokens,
  cleanForAI,
  resolveAiCopySource,
} from "../ai-format";

const SRC = resolve(__dirname, "../ai-format.ts");

describe("cleanForAI — no slug header", () => {
  it("returns cleaned markdown without a # Note: /slug prefix or spacer", () => {
    const out = cleanForAI("hello");
    expect(out).toBe("hello");
    expect(out).not.toMatch(/# Note:\s*\//);
    expect(out.startsWith("# Note:")).toBe(false);
  });

  it("does not reintroduce a slug header when the note already has headings", () => {
    const out = cleanForAI("# Title\n\nbody");
    expect(out).toBe("# Title\n\nbody");
    expect(out).not.toMatch(/^# Note:/);
  });

  it("source no longer builds a slug header", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).not.toMatch(/`# Note:/);
    expect(src).not.toMatch(/function formatForAI/);
    expect(src).not.toMatch(/\$\{slug\}/);
  });
});

describe("cleanForAI — BOM and zero-width", () => {
  it("documents the stripped zero-width set", () => {
    expect([...ZERO_WIDTH_CHARS]).toEqual(["\u200B", "\u200C", "\u200D", "\uFEFF", "\u2060"]);
  });

  it("strips a leading BOM", () => {
    expect(cleanForAI("\uFEFF# hi")).toBe("# hi");
  });

  it.each([...ZERO_WIDTH_CHARS])("strips U+%s from the slice", (ch) => {
    expect(cleanForAI(`hel${ch}lo`)).toBe("hello");
  });

  it("strips mixed BOM + listed ZW chars without touching visible text", () => {
    const raw = `\uFEFFa\u200B b\u200C\u200D c\u2060d\uFEFF`;
    expect(cleanForAI(raw)).toBe("a b cd");
  });
});

describe("cleanForAI — comments, trailing ws, blank collapse", () => {
  it("strips HTML/markdown comments", () => {
    expect(cleanForAI("keep <!-- secret --> me")).toBe("keep  me");
  });

  it("trims trailing spaces and tabs per line", () => {
    expect(cleanForAI("hello   \nworld\t\t")).toBe("hello\nworld");
  });

  it("collapses 3+ newlines to 2", () => {
    expect(cleanForAI("a\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("cleanForAI — fences", () => {
  it("trims trailing spaces on fence lines without changing the language tag", () => {
    const out = cleanForAI("```js  \nconst x = 1\n```");
    expect(out).toBe("```js\nconst x = 1\n```");
  });

  it("appends a closing fence when the slice has an unclosed opener", () => {
    const out = cleanForAI("intro\n```ts\nconst x = 1");
    expect(out).toBe("intro\n```ts\nconst x = 1\n```");
  });

  it("leaves already-closed fences unchanged in meaning", () => {
    const src = "```python\n# not a markdown comment\nx = 1\n```";
    expect(cleanForAI(src)).toBe(src);
  });

  it("does not treat inline backticks as a fence opener", () => {
    expect(cleanForAI("use ` ``` ` in prose")).toBe("use ` ``` ` in prose");
  });
});

describe("resolveAiCopySource — selection vs full", () => {
  it("uses a non-empty non-whitespace editor selection", () => {
    expect(resolveAiCopySource("picked", "# full\n\nnote")).toEqual({
      text: "picked",
      fromSelection: true,
    });
  });

  it("treats empty or whitespace-only selection as full note", () => {
    expect(resolveAiCopySource("", "full")).toEqual({ text: "full", fromSelection: false });
    expect(resolveAiCopySource("  \n\t  ", "full")).toEqual({
      text: "full",
      fromSelection: false,
    });
    expect(resolveAiCopySource(undefined, "full")).toEqual({
      text: "full",
      fromSelection: false,
    });
  });
});

describe("approxTokens", () => {
  it("keeps the ~4 chars/token helper", () => {
    expect(approxTokens("abcd")).toBe(1);
    expect(approxTokens("a".repeat(8))).toBe(2);
  });
});
