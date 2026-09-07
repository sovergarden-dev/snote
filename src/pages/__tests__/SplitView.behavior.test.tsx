import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SplitView from "../SplitView";

const harness = vi.hoisted(() => ({
  noteProps: new Map<string, {
    embedSlug: string;
    embedNarrow?: boolean;
    legacyOnly?: boolean;
    onPrimaryScroller?: (element: HTMLElement | null) => void;
  }>(),
  mountedAs: new Map<string, "NotePage" | "CutoverNotePage">(),
  observers: [] as Array<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
  }>,
}));

vi.mock("../NotePage", () => {
  const MockNotePage = (props: {
    embedSlug: string;
    embedNarrow?: boolean;
    legacyOnly?: boolean;
    onPrimaryScroller?: (element: HTMLElement | null) => void;
  }) => {
    harness.mountedAs.set(props.embedSlug, "NotePage");
    harness.noteProps.set(props.embedSlug, props);
    return <div>note:{props.embedSlug}</div>;
  };
  return {
    default: MockNotePage,
    CutoverNotePage: MockNotePage,
  };
});
vi.mock("../CutoverNotePage", () => {
  const MockCutover = (props: {
    embedSlug: string;
    embedNarrow?: boolean;
    legacyOnly?: boolean;
    onPrimaryScroller?: (element: HTMLElement | null) => void;
  }) => {
    harness.mountedAs.set(props.embedSlug, "CutoverNotePage");
    harness.noteProps.set(props.embedSlug, props);
    return <div>note:{props.embedSlug}</div>;
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

function renderSplit(path = "/alpha+beta") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:slug" element={<SplitView />} />
        <Route path="/" element={<div>home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SplitView responsive behavior", () => {
  beforeEach(() => {
    harness.noteProps.clear();
    harness.mountedAs.clear();
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

  it("embeds editable NotePage in each plain pane when capability routes are enabled", async () => {
    renderSplit();
    await screen.findByText("note:alpha");
    expect(harness.mountedAs.get("alpha")).toBe("NotePage");
    expect(harness.mountedAs.get("beta")).toBe("NotePage");
    expect(harness.noteProps.get("alpha")?.legacyOnly).toBe(false);
    expect(harness.noteProps.get("alpha")?.embedSlug).toBe("alpha");
    expect(harness.noteProps.get("beta")?.embedSlug).toBe("beta");
  });

  it("embeds CutoverNotePage only when ?legacyRo=1", async () => {
    renderSplit("/alpha+beta?legacyRo=1");
    await screen.findByText("note:alpha");
    expect(harness.mountedAs.get("alpha")).toBe("CutoverNotePage");
    expect(harness.mountedAs.get("beta")).toBe("CutoverNotePage");
    expect(harness.noteProps.get("alpha")?.embedSlug).toBe("alpha");
  });

  it("uses accessible keyboard tabs in a narrow split container", async () => {
    const { container } = renderSplit();
    await screen.findByText("note:alpha");
    const workspace = container.querySelector("[data-split-workspace]");
    expect(workspace).not.toBeNull();

    resize(workspace!, 640);

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "/alpha" })).not.toHaveAttribute("hidden");
    expect(container.querySelector("#split-panel-1")).toHaveAttribute("hidden");

    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "/beta" })).not.toHaveAttribute("hidden");
  });

  it("derives each embedded note's compact layout from its pane width", async () => {
    const { container } = renderSplit();
    await screen.findByText("note:alpha");
    const firstPane = container.querySelector("[data-split-view-pane='0']");
    expect(firstPane).not.toBeNull();

    resize(firstPane!, 720);

    expect(harness.noteProps.get("alpha")?.embedNarrow).toBe(true);
    expect(harness.noteProps.get("beta")?.embedNarrow).toBe(false);
  });

  it("exposes sync state to assistive technology", async () => {
    renderSplit();
    const toggle = await screen.findByRole("button", { name: /Sync scroll/i });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("replaces the active pane when a wiki target is not already open", async () => {
    renderSplit();
    await screen.findByText("note:alpha");
    act(() => {
      window.dispatchEvent(new CustomEvent("snotes:wiki-nav", { detail: { slug: "recipes" } }));
    });
    expect(await screen.findByText("note:recipes")).toBeInTheDocument();
    expect(screen.getByText("note:beta")).toBeInTheDocument();
    expect(screen.queryByText("note:alpha")).not.toBeInTheDocument();
    expect(screen.queryByText("home")).not.toBeInTheDocument();
  });

  it("focuses an already-open pane instead of leaving the split", async () => {
    const { container } = renderSplit();
    await screen.findByText("note:alpha");
    act(() => {
      window.dispatchEvent(new CustomEvent("snotes:wiki-nav", { detail: { slug: "beta" } }));
    });
    expect(screen.getByText("note:alpha")).toBeInTheDocument();
    expect(screen.getByText("note:beta")).toBeInTheDocument();
    expect(screen.queryByText("home")).not.toBeInTheDocument();
    expect(container.querySelector("[data-split-view-slug='beta']")).toHaveAttribute(
      "data-split-active",
      "true",
    );
  });

  it("replaces the pane the user last activated, not always the first", async () => {
    const { container } = renderSplit();
    await screen.findByText("note:alpha");
    fireEvent.pointerDown(container.querySelector("[data-split-view-slug='beta']")!);
    act(() => {
      window.dispatchEvent(new CustomEvent("snotes:wiki-nav", { detail: { slug: "recipes" } }));
    });
    expect(await screen.findByText("note:recipes")).toBeInTheDocument();
    expect(screen.getByText("note:alpha")).toBeInTheDocument();
    expect(screen.queryByText("note:beta")).not.toBeInTheDocument();
  });
});
