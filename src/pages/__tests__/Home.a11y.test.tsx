import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import Home from "../Home";

vi.mock("@/components/ThemeToggle", () => ({
  ThemeToggle: () => <button type="button" aria-label="theme.aria">theme</button>,
}));
vi.mock("@/components/SceneToggle", () => ({ SceneToggle: () => null }));
vi.mock("@/components/LanguageToggle", () => ({
  LanguageToggle: () => <button type="button" aria-label="lang.choose">lang</button>,
}));
vi.mock("@/components/note/InstallPrompt", () => ({ InstallPrompt: () => null }));
vi.mock("@/components/home/SceneHost", () => ({ default: () => null }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/use-scene-theme", () => ({
  useSceneTheme: () => ({
    scene: "none",
    committedScene: "none",
    setScene: vi.fn(),
  }),
}));
vi.mock("@/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/ext-context", () => ({ isExtensionContext: true }));
vi.mock("@/lib/recent-notes", () => ({
  getPinned: () => ["pinned"],
  getRecents: () => [{ slug: "recent", lastOpenedAt: Date.now() }],
  removeRecent: () => [],
  togglePin: () => [],
}));
vi.mock("@/lib/capability/client", () => ({
  createCapabilityApi: () => ({ createNote: vi.fn() }),
}));
vi.mock("@/lib/legacy/cutover", () => ({
  createLegacyNoteApi: () => ({ exists: async () => true, open: vi.fn() }),
}));
vi.mock("lucide-react", () => ({
  ArrowRight: () => null,
  Check: () => null,
  Loader2: () => null,
  Shuffle: () => null,
  Star: () => null,
  Trash2: () => null,
}));

function isTabbable(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hasAttribute("disabled")) return false;
  if (el.tabIndex < 0) return false;
  const tag = el.tagName;
  if (tag === "A" && el.hasAttribute("href")) return true;
  if (tag === "BUTTON" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return true;
  return el.tabIndex >= 0;
}

function tabbables() {
  return [...document.querySelectorAll("a[href], button, input, select, textarea, [tabindex]")].filter(isTabbable);
}

function stubPlatform(platform: string) {
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
}

function renderHome() {
  return render(<MemoryRouter><Home /></MemoryRouter>);
}

describe("Home accessibility", () => {
  it("labels slug input, live status, validation error, and hidden row actions", async () => {
    renderHome();

    const input = screen.getByLabelText("home.placeholder");
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(input.getAttribute("aria-describedby")).toContain(status.id);

    fireEvent.change(input, { target: { value: "invalid slug" } });
    fireEvent.click(screen.getByRole("button", { name: /home.btn.open/ }));

    const alert = await screen.findByRole("alert");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toContain(alert.id);

    expect(screen.getByRole("button", { name: "home.pinned.unpin" })).toHaveClass(
      "focus-visible:opacity-100",
      "group-focus-within:opacity-100",
    );
    expect(screen.getByRole("button", { name: "home.recent.remove" })).toHaveClass(
      "focus-visible:opacity-100",
      "group-focus-within:opacity-100",
    );
    expect(await screen.findByLabelText("home.filter.aria")).toBeInTheDocument();
    expect(await screen.findByLabelText("home.templates.aria")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "home.collections.aria" })).toHaveAttribute(
      "aria-label",
      "home.collections.aria",
    );
  });

  it("puts a skip link first so Tab can land on the slug, and keeps the header tabbable", async () => {
    const user = userEvent.setup();
    renderHome();

    const skip = screen.getByRole("link", { name: "home.skip_to_slug" });
    const slug = screen.getByLabelText("home.placeholder");
    const theme = screen.getByRole("button", { name: "theme.aria" });
    const order = tabbables();

    expect(order[0]).toBe(skip);
    expect(order).toContain(slug);
    expect(order).toContain(theme);
    expect(order.indexOf(slug)).toBeGreaterThan(order.indexOf(skip));

    await user.click(skip);
    expect(slug).toHaveFocus();
  });

  it("skips the disabled Open control when Tabbing from the slug field", async () => {
    const user = userEvent.setup();
    renderHome();

    const slug = screen.getByLabelText("home.placeholder");
    const open = screen.getByRole("button", { name: /home.btn.open/ });
    expect(open).toBeDisabled();
    expect(tabbables()).not.toContain(open);

    slug.focus();
    await user.tab();
    expect(open).not.toHaveFocus();
  });

  it("renders Already exists at 12px with foreground contrast, not color-only", async () => {
    renderHome();
    fireEvent.change(screen.getByLabelText("home.placeholder"), { target: { value: "taken-note" } });
    const taken = await screen.findByText("home.status.taken");
    expect(taken.tagName).toBe("SPAN");
    expect(taken.className).toMatch(/\btext-xs\b/);
    expect(taken.className).not.toMatch(/text-\[10px\]/);
    expect(taken.className).not.toMatch(/text-warning/);
    expect(taken.className).toMatch(/text-foreground/);
  });

  it("gives recent-delete a 44px hit target", () => {
    renderHome();
    const remove = screen.getByRole("button", { name: "home.recent.remove" });
    expect(remove.className).toMatch(/\bh-11\b/);
    expect(remove.className).toMatch(/\bw-11\b/);
  });

  it("shows Ctrl+K / Ctrl+P shortcut hints on Windows", () => {
    stubPlatform("Win32");
    renderHome();
    expect(screen.getByText("Ctrl+K")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+P")).toBeInTheDocument();
    expect(screen.queryByText("⌘K")).not.toBeInTheDocument();
  });
});
