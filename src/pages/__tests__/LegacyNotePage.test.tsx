import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LegacyNotePage from "../LegacyNotePage";

const harness = vi.hoisted(() => ({
  open: vi.fn(),
  previewText: vi.fn(),
  unlock: vi.fn(),
  importLegacyNote: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/legacy/cutover", async (original) => {
  const actual = await original<typeof import("@/lib/legacy/cutover")>();
  return {
    ...actual,
    createLegacyNoteApi: () => ({ open: harness.open }),
  };
});
vi.mock("@/lib/capability/client", () => ({
  createCapabilityApi: () => ({ importLegacyNote: harness.importLegacyNote }),
}));
vi.mock("@/hooks/use-toast", () => ({ toast: (...args: unknown[]) => harness.toast(...args) }));
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
  NoteSecurityPanel: ({
    onDuplicateSecurely,
    duplicateBusy,
  }: {
    onDuplicateSecurely?: () => void;
    duplicateBusy?: boolean;
  }) => (
    <>
      <button type="button" aria-label="security.panel_title" />
      {onDuplicateSecurely && (
        <button
          type="button"
          aria-label="security.duplicate_label"
          disabled={duplicateBusy}
          onClick={onDuplicateSecurely}
        />
      )}
    </>
  ),
  LegacyRoBanner: () => (
    <div role="status">
      <span>security.legacy_banner</span>
      <a href="/">security.legacy_banner_cta</a>
    </div>
  ),
}));
vi.mock("react-helmet-async", () => ({ Helmet: () => null }));
vi.mock("lucide-react", () => ({ ArrowLeft: () => null, Eye: () => null, Loader2: () => null }));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{`${location.pathname}${location.search}${location.hash}`}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/daily"]}>
      <Routes>
        <Route
          path="/:slug"
          element={
            <>
              <LocationProbe />
              <LegacyNotePage slug="daily" />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const PLAIN_NOTE = {
  slug: "daily",
  content: "legacy text",
  ydocState: "",
  isEncrypted: false,
  salt: null,
  check: null,
  iterations: null,
};

describe("LegacyNotePage cutover mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/daily");
    localStorage.clear();
  });

  it("hydrates exact-match content into preview without mounting an editor", async () => {
    harness.open.mockResolvedValue(PLAIN_NOTE);

    renderPage();

    await waitFor(() => expect(harness.previewText).toHaveBeenCalledWith("legacy text"));
    expect(screen.getByText("legacy.read_only")).toBeInTheDocument();
    expect(
      screen.getByText("legacy.read_only").compareDocumentPosition(screen.getByRole("status"))
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
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

    renderPage();

    await waitFor(() => expect(harness.unlock).toHaveBeenCalled());
    expect(harness.previewText).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "security.duplicate_label" })).not.toBeInTheDocument();
  });

  it("does not put Duplicate securely on the banner or a slug field", async () => {
    harness.open.mockResolvedValue(PLAIN_NOTE);

    renderPage();

    await waitFor(() => expect(screen.getByText("legacy.read_only")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "legacy.duplicate_securely" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("legacy.new_slug")).not.toBeInTheDocument();
    expect(screen.queryByText("legacy.duplicate_unavailable")).not.toBeInTheDocument();
    expect(screen.getByText("security.legacy_banner")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "security.legacy_banner_cta" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("button", { name: "security.panel_title" })).toBeInTheDocument();
  });

  it("duplicates a ready LNO note through import-legacy and opens #owner=", async () => {
    harness.open.mockResolvedValue(PLAIN_NOTE);
    harness.importLegacyNote.mockImplementation(async (_body: unknown, owner: string) => ({
      capabilities: { owner },
    }));

    renderPage();

    await waitFor(() => expect(screen.getByRole("button", { name: "security.duplicate_label" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "security.duplicate_label" }));

    await waitFor(() => {
      expect(harness.importLegacyNote).toHaveBeenCalledOnce();
    });
    const [body, owner] = harness.importLegacyNote.mock.calls[0] as [
      { slug: string; payload: string; isEncrypted: boolean },
      string,
    ];
    expect(body.slug).toMatch(/^[a-z0-9]{8}$/);
    expect(body.slug).not.toBe("daily");
    expect(body.isEncrypted).toBe(false);
    expect(body.payload).toEqual(expect.any(String));
    expect(owner).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await waitFor(() => {
      expect(screen.getByTestId("loc")).toHaveTextContent(`/${body.slug}#owner=${owner}`);
    });
    expect(harness.toast).toHaveBeenCalledWith({ title: "security.duplicate_success" });
  });

  it("keeps the legacy note and shows an actionable fail toast when import-legacy errors", async () => {
    harness.open.mockResolvedValue(PLAIN_NOTE);
    harness.importLegacyNote.mockRejectedValue(new Error("network lost"));

    renderPage();

    await waitFor(() => expect(screen.getByRole("button", { name: "security.duplicate_label" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "security.duplicate_label" }));

    await waitFor(() => {
      expect(harness.toast).toHaveBeenCalledWith({
        title: "security.duplicate_fail",
        variant: "destructive",
      });
    });
    expect(screen.getByTestId("loc")).toHaveTextContent("/daily");
    expect(screen.getByTestId("loc")).not.toHaveTextContent("#owner=");
    expect(screen.getByRole("button", { name: "security.duplicate_label" })).not.toBeDisabled();
  });

  it("keeps Note security on LNO miss", async () => {
    harness.open.mockResolvedValue(null);

    renderPage();

    await waitFor(() => expect(screen.getByText("legacy.not_found")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "security.panel_title" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "security.duplicate_label" })).not.toBeInTheDocument();
  });
});
