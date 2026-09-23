import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_MATCHES,
  MAX_SELECTION_LENGTH,
  buildSelectionMatchDeco,
  highlightSelectionMatches,
} from "../selection-match";

function stateWith(
  doc: string,
  from: number,
  to: number,
  extraRanges: Array<{ from: number; to: number }> = [],
) {
  const ranges = [EditorSelection.range(from, to), ...extraRanges.map((range) => EditorSelection.range(range.from, range.to))];
  return EditorState.create({
    doc,
    selection: EditorSelection.create(ranges),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  });
}

function rangesOf(deco: DecorationSet): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  deco.between(0, 1e9, (from, to) => {
    ranges.push([from, to]);
  });
  return ranges;
}

function matches(
  doc: string,
  from: number,
  to: number,
  visible?: Array<{ from: number; to: number }>,
  options?: Parameters<typeof buildSelectionMatchDeco>[2],
  extraRanges?: Array<{ from: number; to: number }>,
) {
  const state = stateWith(doc, from, to, extraRanges);
  const span = visible ?? [{ from: 0, to: state.doc.length }];
  return rangesOf(buildSelectionMatchDeco(state, span, options));
}

describe("selection-match cap (A3 / A6)", () => {
  it("documents maxSelectionLength = 4000 (hard off above, not a truncated query)", () => {
    expect(MAX_SELECTION_LENGTH).toBe(4000);
    const src = readFileSync(resolve(__dirname, "../selection-match.ts"), "utf8");
    expect(src).toMatch(/maxSelectionLength\s*=\s*4000|MAX_SELECTION_LENGTH\s*=\s*4000/);
    expect(src).toMatch(/len\s*>\s*(conf\.maxSelectionLength|MAX_SELECTION_LENGTH)/);
  });

  it("A3: selection length 1–200 still highlights other exact occurrences", () => {
    expect(matches("aa aa", 0, 1)).toEqual([
      [1, 2],
      [3, 4],
      [4, 5],
    ]);

    const token200 = "t".repeat(200);
    const doc200 = `${token200} ${token200}`;
    expect(matches(doc200, 0, 200)).toEqual([[201, 401]]);
  });

  it("A6: selection length 201–4000 still highlights other exact occurrences", () => {
    const token201 = "u".repeat(201);
    const doc201 = `${token201}\n${token201}`;
    expect(matches(doc201, 0, 201)).toEqual([[202, 403]]);

    const token4000 = "v".repeat(MAX_SELECTION_LENGTH);
    const doc4000 = `${token4000} ${token4000}`;
    expect(matches(doc4000, 0, MAX_SELECTION_LENGTH)).toEqual([
      [MAX_SELECTION_LENGTH + 1, MAX_SELECTION_LENGTH * 2 + 1],
    ]);
  });

  it("A6: selection length > 4000 yields zero selection-match decorations", () => {
    const token = "w".repeat(MAX_SELECTION_LENGTH + 1);
    const doc = `${token}\n${token}`;
    expect(matches(doc, 0, MAX_SELECTION_LENGTH + 1)).toEqual([]);
  });
});

describe("selection-match CM parity", () => {
  it("A4: multi-range selection produces no decorations", () => {
    expect(matches("hello hello", 0, 5, undefined, undefined, [{ from: 6, to: 11 }])).toEqual([]);
  });

  it("A5: exceeding maxMatches disables all match decorations", () => {
    const doc = Array.from({ length: 4 }, () => "tok").join(" ");
    expect(matches(doc, 0, 3, undefined, { maxMatches: 2 })).toEqual([]);
    expect(matches(doc, 0, 3, undefined, { maxMatches: 3 })).toEqual([
      [4, 7],
      [8, 11],
      [12, 15],
    ]);
  });

  it("keeps stock maxMatches default at 100", () => {
    expect(DEFAULT_MAX_MATCHES).toBe(100);
  });

  it("searches visibleRanges only (viewport-only, same as stock CM)", () => {
    const token = "q".repeat(201);
    const doc = `${token} ${token}`;
    expect(matches(doc, 0, 201, [{ from: 0, to: 201 }])).toEqual([]);
    expect(matches(doc, 0, 201, [{ from: 202, to: doc.length }])).toEqual([[202, 403]]);
  });

  it("skips the current selection itself", () => {
    expect(matches("foo foo", 0, 3)).toEqual([[4, 7]]);
  });

  it("does not match a collapsed caret", () => {
    const state = EditorState.create({ doc: "foo foo", selection: { anchor: 1 } });
    expect(rangesOf(buildSelectionMatchDeco(state, [{ from: 0, to: 7 }]))).toEqual([]);
  });
});

describe("highlightSelectionMatches extension", () => {
  let view: EditorView | undefined;

  afterEach(() => {
    view?.destroy();
    view = undefined;
  });

  it("installs cm-selectionMatch marks for a 201-char selection", () => {
    const token = "z".repeat(201);
    const parent = document.createElement("div");
    document.body.append(parent);
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: `${token} ${token}`,
        selection: EditorSelection.range(0, 201),
        extensions: [highlightSelectionMatches()],
      }),
    });
    const marks = rangesOf(buildSelectionMatchDeco(view.state, view.visibleRanges));
    expect(marks).toEqual([[202, 403]]);
    expect(parent.querySelectorAll(".cm-selectionMatch").length).toBeGreaterThan(0);
    parent.remove();
  });
});

describe("Editor wiring", () => {
  it("uses the local highlighter instead of stock @codemirror/search highlightSelectionMatches", () => {
    const src = readFileSync(resolve(__dirname, "../../components/note/Editor.tsx"), "utf8");
    expect(src).toMatch(/highlightSelectionMatches\s*\(\s*\)/);
    expect(src).toMatch(/import \{[^}]*highlightSelectionMatches[^}]*\} from ["']@\/lib\/selection-match["']/);
    expect(src).not.toMatch(/import \{[^}]*highlightSelectionMatches[^}]*\} from ["']@codemirror\/search["']/);
  });
});
