import { fireEvent, render, screen } from "@testing-library/react";
import { createRef, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { resetNoteIndexForTests, upsertPlaintextNote } from "@/lib/note-index";
import { OutlineSidebar } from "../OutlineSidebar";

const overlay = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => overlay.mobile }));
vi.mock("@/i18n/index", () => ({ useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => {
  if (!vars) return key;
  return Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), key);
} }) }));
vi.mock("lucide-react", () => ({ X: () => null }));

function Harness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const docRef = useRef(new Y.Doc());
  docRef.current.getText("content").insert(0, "# First heading");
  return (
    <>
      <input aria-label="editor" defaultValue="draft" />
      <button ref={triggerRef} onClick={() => setOpen(true)}>Open outline</button>
      <OutlineSidebar
        slug="current"
        doc={docRef.current}
        open={open}
        onOpenChange={setOpen}
        onJump={vi.fn()}
        triggerRef={triggerRef}
      />
    </>
  );
}

describe("OutlineSidebar", () => {
  beforeEach(async () => {
    overlay.mobile = false;
    await resetNoteIndexForTests();
  });

  afterEach(async () => {
    overlay.mobile = false;
    await resetNoteIndexForTests();
  });

  it("keeps a closed drawer out of the accessibility and tab trees", () => {
    const doc = new Y.Doc();
    render(
      <OutlineSidebar
        slug="current"
        doc={doc}
        open={false}
        onOpenChange={vi.fn()}
        onJump={vi.fn()}
        triggerRef={createRef<HTMLButtonElement>()}
      />,
    );
    expect(screen.queryByRole("dialog", { name: "brand.outline" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "brand.outline" })).not.toBeInTheDocument();
  });

  it("reflows as an in-flow complementary region on desktop and does not overlay", () => {
    const doc = new Y.Doc();
    render(
      <OutlineSidebar
        slug="current"
        doc={doc}
        open
        onOpenChange={vi.fn()}
        onJump={vi.fn()}
        triggerRef={createRef<HTMLButtonElement>()}
      />,
    );
    const aside = screen.getByRole("complementary", { name: "brand.outline" });
    expect(screen.queryByRole("dialog", { name: "brand.outline" })).not.toBeInTheDocument();
    expect(aside.className).not.toMatch(/\bfixed\b/);
    expect(aside.className).toMatch(/\brelative\b/);
    expect(document.querySelector("[data-outline-backdrop]")).toBeNull();
  });

  it("does not steal composing focus when opened on desktop", () => {
    render(<Harness />);
    const editor = screen.getByLabelText("editor");
    editor.focus();
    fireEvent.click(screen.getByRole("button", { name: "Open outline" }));
    expect(screen.getByRole("complementary", { name: "brand.outline" })).toBeInTheDocument();
    expect(editor).toHaveFocus();
    expect(screen.getByRole("button", { name: "outline.close" })).not.toHaveFocus();
  });

  it("closes on Escape without restoring trigger focus over the editor", () => {
    render(<Harness />);
    const editor = screen.getByLabelText("editor");
    editor.focus();
    fireEvent.click(screen.getByRole("button", { name: "Open outline" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "brand.outline" })).not.toBeInTheDocument();
    expect(editor).toHaveFocus();
  });

  it("retains the Control/Command plus backslash shortcut", () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    expect(screen.getByRole("complementary", { name: "brand.outline" })).toBeInTheDocument();
  });

  it("overlays on mobile with a backdrop that Esc and close dismiss", () => {
    overlay.mobile = true;
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open outline" }));

    const dialog = screen.getByRole("dialog", { name: "brand.outline" });
    expect(dialog).toHaveAttribute("aria-modal", "false");
    expect(document.querySelector("[data-outline-backdrop]")).not.toBeNull();
    expect(dialog.className).toMatch(/\bfixed\b/);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "brand.outline" })).not.toBeInTheDocument();
  });

  it("dismisses the mobile overlay from the close button without locking composing", () => {
    overlay.mobile = true;
    render(<Harness />);
    const editor = screen.getByLabelText("editor");
    editor.focus();
    fireEvent.click(screen.getByRole("button", { name: "Open outline" }));
    expect(editor).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "outline.close" }));
    expect(screen.queryByRole("dialog", { name: "brand.outline" })).not.toBeInTheDocument();
    expect(editor).toHaveFocus();
  });

  it("lists clickable backlinks from the local index", () => {
    upsertPlaintextNote("journal", "# Journal\nSee [[current]]");
    const doc = new Y.Doc();
    const onOpenNote = vi.fn();
    render(
      <OutlineSidebar
        slug="current"
        doc={doc}
        open
        onOpenChange={vi.fn()}
        onJump={vi.fn()}
        onOpenNote={onOpenNote}
        triggerRef={createRef<HTMLButtonElement>()}
      />,
    );
    expect(screen.getByText("knowledge.backlinks")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "knowledge.open_note" }));
    expect(onOpenNote).toHaveBeenCalledWith("journal");
  });
});
