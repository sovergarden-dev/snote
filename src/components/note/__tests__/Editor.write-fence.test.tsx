import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import { SupabaseYjsProvider } from "@/lib/yjs/provider";
import { EditorView } from "@codemirror/view";
import { Editor } from "../Editor";

function stubRangeGeometry() {
  const prototype = Range.prototype as unknown as Record<string, unknown>;
  const names = ["getClientRects", "getBoundingClientRect"] as const;
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(prototype, name));
  const emptyRect = {
    x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0,
    toJSON: () => ({}),
  } as DOMRect;
  Object.defineProperty(prototype, "getClientRects", {
    configurable: true,
    value: () => [] as unknown as DOMRectList,
  });
  Object.defineProperty(prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => emptyRect,
  });
  return () => {
    names.forEach((name, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(prototype, name, descriptor);
      else Reflect.deleteProperty(prototype, name);
    });
  };
}

function textTransfer(text: string): DataTransfer {
  return {
    getData: (type: string) => type === "text/plain" || type === "Text" ? text : "",
    setData: vi.fn(),
    clearData: vi.fn(),
    files: [],
    items: [],
    types: ["text/plain"],
    dropEffect: "copy",
    effectAllowed: "copy",
  } as unknown as DataTransfer;
}

describe("Editor encryption write fence", () => {
  it("gives the CodeMirror textbox an accessible name", async () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const view = render(<Editor doc={doc} awareness={awareness} />);

    await waitFor(() => expect(
      view.container.querySelector(".cm-content[role='textbox']"),
    ).toHaveAttribute("aria-label", "Markdown note editor"));
  });

  it("reconfigures CodeMirror to read-only while a provider transition is active", async () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const view = render(
      <Editor doc={doc} awareness={awareness} editable={false} />,
    );

    await waitFor(() => expect(
      view.container.querySelector(".cm-content"),
    ).toHaveAttribute("contenteditable", "false"));

    view.rerender(<Editor doc={doc} awareness={awareness} editable />);
    await waitFor(() => expect(
      view.container.querySelector(".cm-content"),
    ).toHaveAttribute("contenteditable", "true"));
  });

  it.each(["paste", "drop"] as const)(
    "rejects %s in the real read-only Editor and never calls the provider save method",
    async (kind) => {
      const text = kind === "paste" ? " pasted content" : " dropped content";
      const sendTransfer = (element: Element) => {
        const transfer = textTransfer(text);
        if (kind === "paste") fireEvent.paste(element, { clipboardData: transfer });
        else fireEvent.drop(element, { dataTransfer: transfer, clientX: 0, clientY: 0 });
      };
      const restoreRangeGeometry = stubRangeGeometry();
      const posAtCoords = vi.spyOn(EditorView.prototype, "posAtCoords").mockReturnValue(0);
      let provider: SupabaseYjsProvider | null = null;
      let view: ReturnType<typeof render> | null = null;
      try {
        const editableDoc = new Y.Doc();
        editableDoc.getText("content").insert(0, "existing text");
        const editableView = render(
          <Editor doc={editableDoc} awareness={new Awareness(editableDoc)} />,
        );
        const editableContent = editableView.container.querySelector(".cm-content");
        expect(editableContent).not.toBeNull();
        await waitFor(() => expect(editableContent).toHaveAttribute("contenteditable", "true"));
        act(() => sendTransfer(editableContent!));
        expect(editableDoc.getText("content").toString()).toContain(text.trim());
        editableView.unmount();

        const doc = new Y.Doc();
        const ytext = doc.getText("content");
        ytext.insert(0, "existing text");
        provider = new SupabaseYjsProvider(`read-only-${kind}`, doc);
        provider.setExpectedEncrypted(true);
        const saveSnapshot = vi.spyOn(provider, "saveSnapshot").mockResolvedValue();
        view = render(
          <Editor doc={doc} awareness={provider.awareness} editable={false} />,
        );
        const content = view.container.querySelector(".cm-content");
        expect(content).not.toBeNull();
        await waitFor(() => expect(content).toHaveAttribute("contenteditable", "false"));
        act(() => sendTransfer(content!));

        expect(ytext.toString()).toBe("existing text");
        expect(saveSnapshot).not.toHaveBeenCalled();
      } finally {
        view?.unmount();
        if (provider) await provider.destroy();
        posAtCoords.mockRestore();
        restoreRangeGeometry();
      }
    },
  );
});
