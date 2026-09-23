import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Compartment } from "@codemirror/state";

// Detect dominant CJK script in text so we can set the right `lang` attribute
// for word-break and font-fallback rules.
const RE_HAN = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
const RE_HIRAGANA_KATAKANA = /[\u3040-\u30ff]/g;
const RE_HANGUL = /[\uac00-\ud7af]/g;
function detectLang(text: string): string {
  if (!text) return "en";
  const sample = text.slice(0, 2000);
  const han = (sample.match(RE_HAN) || []).length;
  const kana = (sample.match(RE_HIRAGANA_KATAKANA) || []).length;
  const hangul = (sample.match(RE_HANGUL) || []).length;
  if (kana > 5 || (kana > 0 && kana >= han / 2)) return "ja";
  if (hangul > 5) return "ko";
  if (han > 5) return "zh";
  return "en";
}
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";
import { findNext, findPrevious, searchKeymap } from "@codemirror/search";
import { editorSearch, openReplacePanel, toggleFindPanel } from "@/components/note/search-panel";
import { completionKeymap } from "@codemirror/autocomplete";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { slashCommands } from "@/lib/slash-commands";
import { tagHighlight } from "@/lib/tag-highlight";
import { pasteMarkdown } from "@/lib/paste-markdown";
import { tableNav } from "@/lib/table-nav";
import { typewriterMode } from "@/lib/typewriter";
import { wikiLink } from "@/lib/wiki-link";
import { highlightSelectionMatches } from "@/lib/selection-match";

interface EditorProps {
  doc: Y.Doc;
  awareness: Awareness;
  className?: string;
  /** Called with the scrollable DOM element (`view.scrollDOM`) when the
   *  editor mounts, and with null when it unmounts. Used by the scroll-sync
   *  hook in NotePage to mirror scroll position into the preview pane. */
  onScrollEl?: (el: HTMLElement | null) => void;
  /** Vim mode toggle. Lazy-loads `@replit/codemirror-vim` on first enable
   *  via a Compartment so the editor itself doesn't need to be re-created. */
  vim?: boolean;
  /** Provider-level write fence used during encryption mode transitions. */
  editable?: boolean;
}

export interface EditorHandle {
  /** Scroll to a 0-indexed line and place the cursor there. */
  jumpToLine: (line: number) => void;
  /** Current CodeMirror selection; empty when the caret is collapsed. */
  getSelectedText: () => string;
}

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
  { doc, awareness, className, onScrollEl, vim = false, editable = true },
  ref,
) {
  // Stable Compartment lives across re-renders so reconfigure() targets the
  // same slot. Re-creating it would force the editor to drop vim state.
  const vimCompartment = useMemo(() => new Compartment(), []);
  const editableCompartment = useMemo(() => new Compartment(), []);
  const initialEditableRef = useRef(editable);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [lang, setLang] = useState("en");

  useImperativeHandle(
    ref,
    () => ({
      jumpToLine: (line: number) => {
        const view = viewRef.current;
        if (!view) return;
        const total = view.state.doc.lines;
        const target = Math.max(1, Math.min(total, line + 1));
        const linePos = view.state.doc.line(target);
        view.dispatch({
          selection: { anchor: linePos.from },
          effects: EditorView.scrollIntoView(linePos.from, { y: "start", yMargin: 16 }),
        });
        view.focus();
      },
      getSelectedText: () => {
        const view = viewRef.current;
        if (!view) return "";
        const { from, to } = view.state.selection.main;
        if (from === to) return "";
        return view.state.sliceDoc(from, to);
      },
    }),
    [],
  );

  // Track dominant script of the document so CSS word-break rules apply.
  // Recompute is throttled (debounce + only on length deltas > 500 chars) so
  // typing into a long doc doesn't pay scanner cost on every keystroke.
  useEffect(() => {
    const ytext = doc.getText("content");
    let lastLen = -1;
    let timer: number | null = null;
    const update = () => {
      const t = ytext.toString();
      if (lastLen === -1 || Math.abs(t.length - lastLen) > 500) {
        lastLen = t.length;
        setLang(detectLang(t));
      }
    };
    update();
    const schedule = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(update, 250);
    };
    ytext.observe(schedule);
    return () => {
      if (timer) window.clearTimeout(timer);
      ytext.unobserve(schedule);
    };
  }, [doc]);

  useEffect(() => {
    if (!hostRef.current) return;
    const ytext = doc.getText("content");

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        editorSearch,
        highlightSelectionMatches(),
        slashCommands(),
        tagHighlight(),
        wikiLink(),
        tableNav(),
        pasteMarkdown(),
        typewriterMode(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          // editorSearch owns Mod-f (toggle). Keep Escape / F3 / Mod-g.
          ...searchKeymap.filter((binding) => binding.key !== "Mod-f"),
          ...completionKeymap,
        ]),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": "Markdown note editor" }),
        yCollab(ytext, awareness),
        // Empty slot — Vim extension is appended later via Compartment so
        // the heavy `@replit/codemirror-vim` chunk only loads on demand.
        vimCompartment.of([]),
        editableCompartment.of(EditorView.editable.of(initialEditableRef.current)),
        EditorView.theme({
          "&": {
            height: "100%",
            fontSize: "15px",
            fontFamily:
              "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
          },
          ".cm-scroller": {
            fontFamily: "inherit",
            paddingTop: "calc(24px + var(--snote-search-gutter, 0px))",
            paddingRight: "max(24px, calc((100% - 760px) / 2))",
            paddingBottom: "24px",
            paddingLeft: "max(24px, calc((100% - 760px) / 2))",
            lineHeight: "1.7",
          },
          ".cm-content": { caretColor: "hsl(var(--foreground))" },
          ".cm-cursor": { borderLeftColor: "hsl(var(--foreground))" },
          "&.cm-focused": { outline: "none" },
          ".cm-gutters": { display: "none" },
          ".cm-activeLine": { backgroundColor: "transparent" },
          ".cm-line": { padding: "0" },
          ".ͼ1 .cm-header": { fontWeight: "700" },
        }),
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    onScrollEl?.(view.scrollDOM);

    // Global find/replace even if focus is outside the editor.
    // Ctrl/Cmd+F toggles this editor's panel. Unrelated inputs keep native find.
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      const key = e.key.toLowerCase();
      const findChord =
        (e.metaKey || e.ctrlKey) && key === "f" && !e.shiftKey && !e.altKey;
      // Ctrl+H on Win/Linux. Skip Meta+H so macOS "Hide Window" still works.
      const openReplaceCtrlH = e.ctrlKey && !e.metaKey && key === "h" && !e.shiftKey && !e.altKey;
      // Cmd+Option+F — CodeMirror's macOS replace chord.
      const openReplaceMac = e.metaKey && e.altKey && key === "f" && !e.shiftKey;
      const findNextChord = e.key === "F3" && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (!findChord && !openReplaceCtrlH && !openReplaceMac && !findNextChord) return;

      const inThisSearchPanel = Boolean(
        el && view.dom.contains(el) && el.closest(".snote-search-panel"),
      );
      const isFormField = Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"));
      if (isFormField && !inThisSearchPanel) return;

      e.preventDefault();
      if (findChord) {
        toggleFindPanel(view);
        return;
      }
      if (findNextChord) {
        if (e.shiftKey) findPrevious(view);
        else findNext(view);
        return;
      }
      view.focus();
      openReplacePanel(view);
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);
      onScrollEl?.(null);
      view.destroy();
      viewRef.current = null;
    };
  }, [doc, awareness, onScrollEl, vimCompartment, editableCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableCompartment.reconfigure(EditorView.editable.of(editable)),
    });
  }, [editable, editableCompartment]);

  // Toggle vim mode without recreating the editor. Lazy-imports the chunk
  // on first enable; subsequent toggles reuse the module.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;
    if (vim) {
      void import("@replit/codemirror-vim").then(({ vim: vimExt }) => {
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({ effects: vimCompartment.reconfigure(vimExt()) });
      });
    } else {
      view.dispatch({ effects: vimCompartment.reconfigure([]) });
    }
    return () => {
      cancelled = true;
    };
  }, [vim, vimCompartment]);

  return <div ref={hostRef} lang={lang} className={className} />;
});
