import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SplitView from "../SplitView";
import { saveLastSplitView } from "@/lib/split-view-persistence";

const harness = vi.hoisted(() => ({
  noteProps: [] as Array<{
    embedSlug: string;
    embedNarrow?: boolean;
    legacyOnly?: boolean;
  }>,
  observers: [] as Array<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
  }>,
}));

vi.mock("../NotePage", () => {
  const MockNotePage = (props: { embedSlug: string; embedNarrow?: boolean; legacyOnly?: boolean }) => {
    harness.noteProps.push(props);
    return <div data-testid={`note-pane-${harness.noteProps.length - 1}`}>note:{props.embedSlug}</div>;
  };
  return {
    default: MockNotePage,
    CutoverNotePage: MockNotePage,
  };
});
vi.mock("../CutoverNotePage", () => {
  const MockCutover = (props: { embedSlug: string; embedNarrow?: boolean; legacyOnly?: boolean }) => {
    harness.noteProps.push(props);
    return <div data-testid={`note-pane-${harness.noteProps.length - 1}`}>note:{props.embedSlug}</div>;
  };
  return {
    default: MockCutover,
    CutoverNotePage: MockCutover,
  };
});
vi.mock("@/components/app/AppShell", () => ({
  AppShell: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/hooks/use-scene-theme", () => ({ useSceneTheme: () => ({ scene: "none" }) }));
vi.mock("@/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/split-view-persistence", () => ({ saveLastSplitView: vi.fn() }));
vi.mock("react-helmet-async", () => ({ Helmet: () => null }));
vi.mock("lucide-react", () => ({ ArrowLeft: () => null, Link2: () => null }));

function resize(element: Element, width: number) {
  const observer = harness.observers.find((candidate) => candidate.elements.has(element));
  if (!observer) throw new Error("No ResizeObserver is watching the requested element");
  act(() => {
    observer.callback(
      [{ target: element, contentRect: { width } as DOMRectReadOnly } as ResizeObserverEntry],
      observer as unknown as ResizeObserver,
    );
  });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderSplit(path: string) {
  harness.noteProps.length = 0;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/:slug"
          element={
            <>
              <LocationProbe />
              <SplitView />
            </>
          }
        />
        <Route path="/" element={<div>home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SplitView same-note split (Option D)", () => {
  beforeEach(() => {
    harness.noteProps.length = 0;
    harness.observers.length = 0;
    class ResizeObserverMock {
      private readonly record: (typeof harness.observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, elements: new Set() };
        harness.observers.push(this.record);
      }
      observe = (element: Element) => this.record.elements.add(element);
      unobserve = (element: Element) => this.record.elements.delete(element);
      disconnect = () => this.record.elements.clear();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  it("A1: /slug+slug stays two panes and does not redirect home or collapse", async () => {
    renderSplit("/123+123");
    expect(await screen.findByTestId("location")).toHaveTextContent("/123+123");
    expect(screen.queryByText("home")).not.toBeInTheDocument();
    const panes = document.querySelectorAll("[data-split-view-pane]");
    expect(panes).toHaveLength(2);
    expect(await screen.findAllByText("note:123")).toHaveLength(2);
  });

  it("A2: /a+a+b keeps three panes including the duplicate a", async () => {
    renderSplit("/a+a+b");
    expect(await screen.findByTestId("location")).toHaveTextContent("/a+a+b");
    expect(document.querySelectorAll("[data-split-view-pane]")).toHaveLength(3);
    expect(screen.getAllByText("note:a")).toHaveLength(2);
    expect(screen.getByText("note:b")).toBeInTheDocument();
  });

  it("A3: invalid pane count still goes home", async () => {
    renderSplit("/only");
    expect(await screen.findByText("home")).toBeInTheDocument();
  });

  it("A4/G1: distinct-slug splits still render two notes", async () => {
    renderSplit("/alpha+beta");
    await screen.findByText("note:alpha");
    expect(screen.getByText("note:beta")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-split-view-pane]")).toHaveLength(2);
  });

  it("C1: duplicate identities default Sync scroll OFF", async () => {
    renderSplit("/n+n");
    const toggle = await screen.findByRole("button", { name: /Sync scroll/i });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("C4: distinct-slug-only splits still default Sync ON", async () => {
    renderSplit("/alpha+beta");
    const toggle = await screen.findByRole("button", { name: /Sync scroll/i });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("E1: desktop header lists /slug + /slug without collapsing", async () => {
    renderSplit("/n+n");
    await screen.findAllByText("note:n");
    const chrome = document.querySelector("header .font-mono");
    expect(chrome?.textContent).toBe("/n + /n");
  });

  it("E2/E3: compact tabs use ordinal labels and pane-index keys", async () => {
    const { container } = renderSplit("/n+n");
    await screen.findAllByText("note:n");
    const workspace = container.querySelector("[data-split-workspace]");
    resize(workspace!, 640);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent("/n · 1");
    expect(tabs[1]).toHaveTextContent("/n · 2");
    expect(tabs[0]).toHaveAttribute("id", "split-tab-0");
    expect(tabs[1]).toHaveAttribute("id", "split-tab-1");
    expect(tabs[0]).toHaveAttribute("aria-controls", "split-panel-0");
    expect(tabs[1]).toHaveAttribute("aria-controls", "split-panel-1");
  });

  it("G2: compact tabs for distinct slugs stay /{a}, /{b}", async () => {
    const { container } = renderSplit("/alpha+beta");
    await screen.findByText("note:alpha");
    resize(container.querySelector("[data-split-workspace]")!, 640);
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveTextContent("/alpha");
    expect(tabs[1]).toHaveTextContent("/beta");
    expect(tabs[0].textContent).not.toMatch(/·/);
  });

  it("F3: wiki-nav to a duplicate identity focuses the first matching pane", async () => {
    renderSplit("/n+n");
    await screen.findAllByText("note:n");
    act(() => {
      window.dispatchEvent(new CustomEvent("snotes:wiki-nav", { detail: { slug: "n" } }));
    });
    expect(screen.getByTestId("location")).toHaveTextContent("/n+n");
    expect(document.querySelector("[data-split-view-pane='0']")).toHaveAttribute(
      "data-split-active",
      "true",
    );
    expect(document.getElementById("split-panel-0")).toHaveFocus();
  });

  it("F3: wiki-nav to an already-open identity activates that pane", async () => {
    const { container } = renderSplit("/alpha+beta");
    await screen.findByText("note:alpha");
    fireEvent.pointerDown(container.querySelector("[data-split-view-slug='beta']")!);
    act(() => {
      window.dispatchEvent(new CustomEvent("snotes:wiki-nav", { detail: { slug: "alpha" } }));
    });
    expect(screen.getByTestId("location")).toHaveTextContent("/alpha+beta");
    expect(container.querySelector("[data-split-view-slug='alpha']")).toHaveAttribute(
      "data-split-active",
      "true",
    );
  });

  it("F4: wiki-nav still replaces the active pane when the target is not already shown", async () => {
    renderSplit("/alpha+beta");
    await screen.findByText("note:alpha");
    act(() => {
      window.dispatchEvent(new CustomEvent("snotes:wiki-nav", { detail: { slug: "recipes" } }));
    });
    expect(await screen.findByTestId("location")).toHaveTextContent("/recipes+beta");
    expect(screen.getByText("note:recipes")).toBeInTheDocument();
    expect(screen.getByText("note:beta")).toBeInTheDocument();
    expect(screen.queryByText("note:alpha")).not.toBeInTheDocument();
  });

  it("E4: compact tablist arrows still cycle duplicate panes", async () => {
    const { container } = renderSplit("/n+n");
    await screen.findAllByText("note:n");
    resize(container.querySelector("[data-split-workspace]")!, 640);
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tabs[1], { key: "Home" });
    expect(tabs[0]).toHaveFocus();
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("G3: 3-pane layout still renders when a slug is duplicated", async () => {
    renderSplit("/a+a+b");
    expect(document.querySelectorAll("[data-split-view-pane]")).toHaveLength(3);
    expect(document.querySelector("[data-split-view-pane='2']")).toHaveClass("md:col-span-2");
  });

  it("A6: persisting the split keeps duplicate slug order", async () => {
    renderSplit("/123+123");
    await screen.findAllByText("note:123");
    expect(saveLastSplitView).toHaveBeenCalledWith(["123", "123"]);
  });
});
