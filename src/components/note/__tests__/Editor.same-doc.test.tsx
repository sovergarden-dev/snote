import { createRef } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Editor, type EditorHandle } from "../Editor";

function stubRanges() {
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
}

function viewOf(container: HTMLElement, index: number) {
  const editors = container.querySelectorAll(".cm-editor");
  const node = editors[index];
  if (!(node instanceof HTMLElement)) throw new Error("missing editor");
  const view = EditorView.findFromDOM(node);
  if (!view) throw new Error("missing EditorView");
  return view;
}

describe("Editor dual viewport on one Y.Doc (B2/B3/C5)", () => {
  beforeEach(stubRanges);
  afterEach(() => cleanup());

  it("B3: typing in one EditorView updates the sibling on the same doc", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "hello");
    const awareness = new Awareness(doc);
    const { container } = render(
      <>
        <Editor doc={doc} awareness={awareness} />
        <Editor doc={doc} awareness={awareness} />
      </>,
    );
    await waitFor(() => expect(container.querySelectorAll(".cm-content")).toHaveLength(2));
    const first = viewOf(container, 0);
    const second = viewOf(container, 1);
    first.dispatch(first.state.update({
      changes: { from: 5, insert: " world" },
    }));
    await waitFor(() => {
      expect(first.state.doc.toString()).toBe("hello world");
      expect(second.state.doc.toString()).toBe("hello world");
    });
  });

  it("C5: selecting in pane 0 does not change pane 1 selection", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "hello world");
    const awareness = new Awareness(doc);
    const leftRef = createRef<EditorHandle>();
    const rightRef = createRef<EditorHandle>();
    const { container } = render(
      <>
        <Editor ref={leftRef} doc={doc} awareness={awareness} />
        <Editor ref={rightRef} doc={doc} awareness={awareness} />
      </>,
    );
    await waitFor(() => expect(container.querySelectorAll(".cm-content")).toHaveLength(2));
    const first = viewOf(container, 0);
    const second = viewOf(container, 1);
    first.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(leftRef.current?.getSelectedText()).toBe("hello");
    expect(rightRef.current?.getSelectedText()).toBe("");
    expect(second.state.selection.main.empty).toBe(true);
  });

  it("F1: two EditorViews on one Awareness keep a single local client", async () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "hello");
    const awareness = new Awareness(doc);
    awareness.setLocalState({ user: { name: "me", color: "#000" } });
    const { container } = render(
      <>
        <Editor doc={doc} awareness={awareness} />
        <Editor doc={doc} awareness={awareness} />
      </>,
    );
    await waitFor(() => expect(container.querySelectorAll(".cm-content")).toHaveLength(2));
    const first = viewOf(container, 0);
    const second = viewOf(container, 1);
    first.dispatch(first.state.update({ changes: { from: 5, insert: "!" } }));
    second.dispatch({ selection: { anchor: 0, head: 1 } });
    await waitFor(() => expect(first.state.doc.toString()).toBe("hello!"));
    const clientIds = [...awareness.getStates().keys()];
    expect(clientIds).toEqual([awareness.clientID]);
    expect(awareness.getLocalState()?.user).toEqual({ name: "me", color: "#000" });
  });
});
