import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { HistoryDialog } from "../HistoryDialog";
import { dict } from "@/i18n/catalog";
import { I18nProvider } from "@/i18n/provider";
import { STORAGE_KEY } from "@/i18n";
import type { Snapshot } from "@/lib/snapshots";

const harness = vi.hoisted(() => ({
  listSnapshots: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/snapshots", async () => {
  const actual = await vi.importActual<typeof import("@/lib/snapshots")>("@/lib/snapshots");
  return {
    ...actual,
    listSnapshots: (...args: unknown[]) => harness.listSnapshots(...args),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  toast: (args: unknown) => harness.toast(args),
}));

function Wrap({ children }: { children: ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}

const CONTEXT_PAD = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"];
const OLD_TEXT = ["A-old", ...CONTEXT_PAD, "B-old"].join("\n");
const NEW_TEXT = ["A-new", ...CONTEXT_PAD, "B-new"].join("\n");

function snapshot(partial: Partial<Snapshot> & Pick<Snapshot, "id" | "content" | "ts">): Snapshot {
  return {
    slug: "demo",
    charCount: partial.content.length,
    preview: partial.content.slice(0, 200),
    kind: "periodic",
    ...partial,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, "en");
  harness.listSnapshots.mockReset();
  harness.toast.mockReset();
});

describe("HistoryDialog selective restore", () => {
  it("restores only the checked hunk into the live Y.Text", async () => {
    const now = Date.now();
    harness.listSnapshots.mockResolvedValue([
      snapshot({ id: 1, ts: now - 60_000, content: OLD_TEXT }),
    ]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    const doc = new Y.Doc();
    doc.getText("content").insert(0, NEW_TEXT);

    render(
      <Wrap>
        <HistoryDialog slug="demo" doc={doc} open trigger={false} />
      </Wrap>,
    );

    expect(await screen.findByText(dict.en["history.burst.heading"])).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: dict.en["history.burst.compare"] }));

    const boxes = await screen.findAllByRole("checkbox", { name: new RegExp(dict.en["history.hunk.aria"]) });
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[0]);

    fireEvent.click(screen.getByRole("button", { name: dict.en["history.hunk.restore_n"].replace("{n}", "1") }));
    expect(confirm).toHaveBeenCalled();
    const message = String(confirm.mock.calls[0]?.[0] ?? "");
    expect(message).toMatch(/every open device/i);
    expect(message).toMatch(/slug/i);
    expect(doc.getText("content").toString()).toBe(["A-old", ...CONTEXT_PAD, "B-new"].join("\n"));
  });

  it("keeps snapshot plaintext hidden when listing fails closed", async () => {
    harness.listSnapshots.mockRejectedValue(new Error("snapshot key required"));
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "live secret must stay in the editor");

    render(
      <Wrap>
        <HistoryDialog slug="demo" doc={doc} open trigger={false} />
      </Wrap>,
    );

    expect(await screen.findByText(dict.en["history.empty"])).toBeInTheDocument();
    expect(screen.queryByText("live secret must stay in the editor")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: dict.en["history.tab.diff"] })).not.toBeInTheDocument();
  });

  it("does not restore hunks when the new side is not the live note", async () => {
    const now = Date.now();
    harness.listSnapshots.mockResolvedValue([
      snapshot({ id: 1, ts: now - 60_000, content: OLD_TEXT }),
      snapshot({ id: 2, ts: now - 120_000, content: "older\n" + CONTEXT_PAD.join("\n") }),
    ]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const doc = new Y.Doc();
    doc.getText("content").insert(0, NEW_TEXT);

    render(
      <Wrap>
        <HistoryDialog slug="demo" doc={doc} open trigger={false} />
      </Wrap>,
    );

    expect(await screen.findByText(dict.en["history.burst.heading"])).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: dict.en["history.burst.compare"] }));
    expect((await screen.findAllByRole("checkbox")).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByTestId("history-diff-new"), { target: { value: "1" } });

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    const restore = screen.getByRole("button", { name: dict.en["history.hunk.restore"] });
    expect(restore).toBeDisabled();
    fireEvent.click(restore);
    expect(confirm).not.toHaveBeenCalled();
    expect(doc.getText("content").toString()).toBe(NEW_TEXT);
  });

  it("keeps encrypted ordinary-note history view-only", async () => {
    const now = Date.now();
    harness.listSnapshots.mockResolvedValue([
      snapshot({ id: 1, ts: now - 60_000, content: OLD_TEXT }),
    ]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const doc = new Y.Doc();
    doc.getText("content").insert(0, NEW_TEXT);

    render(
      <Wrap>
        <HistoryDialog slug="demo" doc={doc} open trigger={false} readOnly />
      </Wrap>,
    );

    expect(await screen.findByText(dict.en["history.burst.heading"])).toBeInTheDocument();
    const restore = screen.getByRole("button", { name: dict.en["history.restore"] });
    const clear = screen.getByRole("button", { name: dict.en["history.clear"] });
    expect(restore).toBeDisabled();
    expect(clear).toBeDisabled();
    fireEvent.click(restore);
    fireEvent.click(clear);
    expect(confirm).not.toHaveBeenCalled();
    expect(doc.getText("content").toString()).toBe(NEW_TEXT);

    fireEvent.click(screen.getByRole("button", { name: dict.en["history.view"] }));
    const restoreViewedSnapshot = screen.getByRole("button", {
      name: dict.en["history.restore_btn"],
    });
    expect(restoreViewedSnapshot).toBeDisabled();
    fireEvent.click(restoreViewedSnapshot);
    expect(confirm).not.toHaveBeenCalled();
    expect(doc.getText("content").toString()).toBe(NEW_TEXT);

    fireEvent.click(screen.getByRole("button", { name: dict.en["history.back"] }));
    fireEvent.click(screen.getByRole("button", { name: dict.en["history.burst.compare"] }));
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    const restoreHunks = screen.getByRole("button", {
      name: dict.en["history.hunk.restore"],
    });
    expect(restoreHunks).toBeDisabled();
    fireEvent.click(restoreHunks);
    expect(confirm).not.toHaveBeenCalled();
    expect(doc.getText("content").toString()).toBe(NEW_TEXT);
  });
});
