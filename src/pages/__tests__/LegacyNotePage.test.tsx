import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LegacyNotePage from "../LegacyNotePage";

const harness = vi.hoisted(() => ({
  open: vi.fn(),
  previewText: vi.fn(),
  unlock: vi.fn(),
}));

vi.mock("@/lib/legacy/cutover", async (original) => {
  const actual = await original<typeof import("@/lib/legacy/cutover")>();
  return {
    ...actual,
    createLegacyNoteApi: () => ({ open: harness.open }),
  };
});
vi.mock("@/components/note/Preview", () => ({
  Preview: ({ doc }: { doc: import("yjs").Doc }) => {
    harness.previewText(doc.getText("content").toString());
    return <div data-testid="preview" />;
  },
}));
vi.mock("@/components/note/UnlockForm", () => ({
  UnlockForm: () => { harness.unlock(); return <div data-testid="unlock" />; },
}));
vi.mock("@/components/app/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/note/NoteSecurityPanel", () => ({
  NoteSecurityPanel: () => <button type="button" aria-label="security.panel_title" />,
  LegacyRoBanner: () => (
    <div role="status">
      <span>security.legacy_banner</span>
      <a href="/">security.legacy_banner_cta</a>
    </div>
  ),
}));
vi.mock("react-helmet-async", () => ({ Helmet: () => null }));
vi.mock("lucide-react", () => ({ ArrowLeft: () => null, Eye: () => null, Loader2: () => null }));

describe("LegacyNotePage cutover mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/daily");
  });

  it("hydrates exact-match content into preview without mounting an editor", async () => {
    harness.open.mockResolvedValue({
      slug: "daily",
      content: "legacy text",
      ydocState: "",
      isEncrypted: false,
      salt: null,
      check: null,
      iterations: null,
    });

    render(<MemoryRouter><LegacyNotePage slug="daily" /></MemoryRouter>);

    await waitFor(() => expect(harness.previewText).toHaveBeenCalledWith("legacy text"));
    expect(screen.getByText("legacy.read_only")).toBeInTheDocument();
  });

  it("does not mount legacy ciphertext before unlock", async () => {
    harness.open.mockResolvedValue({
      slug: "daily",
      content: "",
      ydocState: "Y2lwaGVydGV4dA==",
      isEncrypted: true,
      salt: "salt",
      check: "check",
      iterations: 600_000,
    });

    render(<MemoryRouter><LegacyNotePage slug="daily" /></MemoryRouter>);

    await waitFor(() => expect(harness.unlock).toHaveBeenCalled());
    expect(harness.previewText).not.toHaveBeenCalled();
  });

  it("does not offer Duplicate securely (import-legacy is not on this origin)", async () => {
    harness.open.mockResolvedValue({
      slug: "daily",
      content: "legacy text",
      ydocState: "",
      isEncrypted: false,
      salt: null,
      check: null,
      iterations: null,
    });

    render(<MemoryRouter><LegacyNotePage slug="daily" /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText("legacy.read_only")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "legacy.duplicate_securely" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("legacy.new_slug")).not.toBeInTheDocument();
    expect(screen.queryByText("legacy.duplicate_unavailable")).not.toBeInTheDocument();
    expect(screen.getByText("security.legacy_banner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "security.panel_title" })).toBeInTheDocument();
  });

  it("keeps Note security on LNO miss", async () => {
    harness.open.mockResolvedValue(null);

    render(<MemoryRouter><LegacyNotePage slug="daily" /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText("legacy.not_found")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "security.panel_title" })).toBeInTheDocument();
  });
});
