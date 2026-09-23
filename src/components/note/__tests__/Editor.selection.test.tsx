import { createRef } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Editor, type EditorHandle } from "../Editor";

describe("Editor getSelectedText", () => {
  beforeEach(() => {
    Range.prototype.getClientRects = function () {
      return [] as unknown as DOMRectList;
    };
    Range.prototype.getBoundingClientRect = function () {
      return {
        x: 0,
        y: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        width: 0,
        height: 0,
        toJSON() {
          return this;
        },
      } as DOMRect;
    };
  });

  afterEach(() => cleanup());

  it("returns the CodeMirror document selection, not window chrome selection", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "hello world");
    const awareness = new Awareness(doc);
    const ref = createRef<EditorHandle>();
    const { container } = render(<Editor ref={ref} doc={doc} awareness={awareness} />);
    await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());

    const cm = container.querySelector(".cm-editor");
    if (!(cm instanceof HTMLElement)) throw new Error("missing editor");
    const view = EditorView.findFromDOM(cm);
    if (!view) throw new Error("missing EditorView");
    view.dispatch({ selection: { anchor: 0, head: 5 } });

    const chrome = document.createElement("textarea");
    chrome.value = "CHROME UI";
    document.body.append(chrome);
    chrome.select();

    expect(ref.current?.getSelectedText()).toBe("hello");
    chrome.remove();
  });

  it("returns empty when the editor caret is collapsed", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "hello world");
    const awareness = new Awareness(doc);
    const ref = createRef<EditorHandle>();
    const { container } = render(<Editor ref={ref} doc={doc} awareness={awareness} />);
    await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
    expect(ref.current?.getSelectedText()).toBe("");
  });
});
