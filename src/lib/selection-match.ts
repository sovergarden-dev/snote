// Selection-match highlighter forked from CodeMirror `@codemirror/search`
// getDeco. Stock CM hard-caps at `len > 200`; public options cannot raise it.
// We keep viewport-only SearchCursor scans, maxMatches ≈ 100, and multi-range
// → no decorations, but raise the selection-length cap to 4000 (hard off above).
import { SearchCursor } from "@codemirror/search";
import { CharCategory, combineConfig, Facet, type EditorState } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

/** Documented product cap. L > this → zero selection-match decorations. */
export const MAX_SELECTION_LENGTH = 4000;
export const DEFAULT_MAX_MATCHES = 100;
const DEFAULT_MIN_SELECTION_LENGTH = 1;

export type SelectionMatchOptions = {
  highlightWordAroundCursor?: boolean;
  minSelectionLength?: number;
  maxSelectionLength?: number;
  maxMatches?: number;
  wholeWords?: boolean;
};

type ResolvedSelectionMatchOptions = {
  highlightWordAroundCursor: boolean;
  minSelectionLength: number;
  maxSelectionLength: number;
  maxMatches: number;
  wholeWords: boolean;
};

const defaultHighlightOptions: ResolvedSelectionMatchOptions = {
  highlightWordAroundCursor: false,
  minSelectionLength: DEFAULT_MIN_SELECTION_LENGTH,
  maxSelectionLength: MAX_SELECTION_LENGTH,
  maxMatches: DEFAULT_MAX_MATCHES,
  wholeWords: false,
};

const highlightConfig = Facet.define<SelectionMatchOptions, ResolvedSelectionMatchOptions>({
  combine(options) {
    return combineConfig(options, defaultHighlightOptions, {
      highlightWordAroundCursor: (a, b) => a || b,
      minSelectionLength: Math.min,
      maxSelectionLength: Math.min,
      maxMatches: Math.min,
      wholeWords: (a, b) => a || b,
    });
  },
});

const matchDeco = Decoration.mark({ class: "cm-selectionMatch" });
const mainMatchDeco = Decoration.mark({ class: "cm-selectionMatch cm-selectionMatch-main" });

function insideWordBoundaries(
  check: (value: string) => CharCategory,
  state: EditorState,
  from: number,
  to: number,
) {
  return (
    (from === 0 || check(state.sliceDoc(from - 1, from)) !== CharCategory.Word) &&
    (to === state.doc.length || check(state.sliceDoc(to, to + 1)) !== CharCategory.Word)
  );
}

function insideWord(
  check: (value: string) => CharCategory,
  state: EditorState,
  from: number,
  to: number,
) {
  return (
    check(state.sliceDoc(from, from + 1)) === CharCategory.Word &&
    check(state.sliceDoc(to - 1, to)) === CharCategory.Word
  );
}

export function buildSelectionMatchDeco(
  state: EditorState,
  visibleRanges: readonly { from: number; to: number }[],
  options?: SelectionMatchOptions,
): DecorationSet {
  const conf: ResolvedSelectionMatchOptions = {
    ...defaultHighlightOptions,
    ...options,
  };
  const sel = state.selection;
  if (sel.ranges.length > 1) return Decoration.none;
  const range = sel.main;
  let query: string;
  let check: ((value: string) => CharCategory) | null = null;
  if (range.empty) {
    if (!conf.highlightWordAroundCursor) return Decoration.none;
    const word = state.wordAt(range.head);
    if (!word) return Decoration.none;
    check = state.charCategorizer(range.head);
    query = state.sliceDoc(word.from, word.to);
  } else {
    const len = range.to - range.from;
    if (len < conf.minSelectionLength || len > conf.maxSelectionLength) return Decoration.none;
    if (conf.wholeWords) {
      query = state.sliceDoc(range.from, range.to);
      check = state.charCategorizer(range.head);
      if (
        !(
          insideWordBoundaries(check, state, range.from, range.to) &&
          insideWord(check, state, range.from, range.to)
        )
      ) {
        return Decoration.none;
      }
    } else {
      query = state.sliceDoc(range.from, range.to);
      if (!query) return Decoration.none;
    }
  }
  const deco = [];
  for (const part of visibleRanges) {
    const cursor = new SearchCursor(state.doc, query, part.from, part.to);
    while (!cursor.next().done) {
      const { from, to } = cursor.value;
      if (!check || insideWordBoundaries(check, state, from, to)) {
        if (range.empty && from <= range.from && to >= range.to) deco.push(mainMatchDeco.range(from, to));
        else if (from >= range.to || to <= range.from) deco.push(matchDeco.range(from, to));
        if (deco.length > conf.maxMatches) return Decoration.none;
      }
    }
  }
  return Decoration.set(deco);
}

const matchHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.getDeco(view);
    }
    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged || update.viewportChanged) {
        this.decorations = this.getDeco(update.view);
      }
    }
    getDeco(view: EditorView) {
      return buildSelectionMatchDeco(
        view.state,
        view.visibleRanges,
        view.state.facet(highlightConfig),
      );
    }
  },
  {
    decorations: (value) => value.decorations,
  },
);

const defaultTheme = EditorView.baseTheme({
  ".cm-selectionMatch": { backgroundColor: "#99ff7780" },
  ".cm-searchMatch .cm-selectionMatch": { backgroundColor: "transparent" },
});

export function highlightSelectionMatches(options?: SelectionMatchOptions) {
  const ext = [defaultTheme, matchHighlighter];
  if (options) ext.push(highlightConfig.of(options));
  return ext;
}
