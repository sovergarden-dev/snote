import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LegacyRoBanner, NoteSecurityPanel } from "../NoteSecurityPanel";
import { legacyOptInConfirmStorageKey, markLegacyOptInConfirmed } from "@/lib/legacy/legacy-opt-in";
import type { CapabilityAccess } from "@/lib/capability/url";

vi.mock("@/components/note/LockButton", () => ({
  LockButton: ({ disabled }: { disabled?: boolean }) => (
    <button
      type="button"
      role="switch"
      aria-labelledby="security-encrypt-label"
      aria-checked="false"
      disabled={disabled}
    >
      encrypt-control
    </button>
  ),
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n/index", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("lucide-react", () => ({
  Lock: () => null,
  LockOpen: () => null,
  ChevronDown: () => null,
  CopyPlus: () => null,
  Loader2: () => null,
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{`${location.pathname}${location.search}${location.hash}`}</div>;
}

function renderPanel({
  path = "/daily",
  legacyOn = false,
  allowEncryptionTransitions = true,
  loading = false,
  ownerOnly = false,
  slug = "daily",
  capabilityAccess = null,
  isEncrypted = false,
  onDuplicateSecurely,
  duplicateBusy = false,
  duplicateFeedback = null,
}: {
  path?: string;
  legacyOn?: boolean;
  allowEncryptionTransitions?: boolean;
  loading?: boolean;
  ownerOnly?: boolean;
  slug?: string;
  capabilityAccess?: CapabilityAccess | null;
  isEncrypted?: boolean;
  onDuplicateSecurely?: () => void;
  duplicateBusy?: boolean;
  duplicateFeedback?: "network" | "permission" | "retry" | "success" | null;
} = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TooltipProvider>
        <Routes>
          <Route
            path="/:slug"
            element={
              <>
                <LocationProbe />
                <NoteSecurityPanel
                  slug={slug}
                  doc={new Y.Doc()}
                  isEncrypted={isEncrypted}
                  allowEncryptionTransitions={allowEncryptionTransitions}
                  capabilityAccess={capabilityAccess}
                  legacyOn={legacyOn}
                  loading={loading}
                  ownerOnly={ownerOnly}
                  onDuplicateSecurely={onDuplicateSecurely}
                  duplicateBusy={duplicateBusy}
                  duplicateFeedback={duplicateFeedback}
                />
              </>
            }
          />
        </Routes>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

async function openPanel() {
  await userEvent.click(screen.getByRole("button", { name: "security.panel_title" }));
  return screen.findByRole("heading", { name: "security.panel_title" });
}

describe("NoteSecurityPanel", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it("keeps Legacy off by default and lists Encrypt separately under Advanced", async () => {
    renderPanel({ legacyOn: false });
    await openPanel();

    expect(screen.getByText("security.encrypt_label")).toBeInTheDocument();
    expect(screen.getByText("security.encrypt_helper")).toBeInTheDocument();
    expect(screen.queryByText("security.encrypt_helper_unavailable")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "security.encrypt_label" })).not.toBeDisabled();
    expect(screen.getByText("security.advanced")).toBeInTheDocument();
    const legacySwitch = screen.getByRole("switch", { name: "security.legacy_label" });
    expect(legacySwitch).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("security.legacy_helper_off")).toBeInTheDocument();
    expect(screen.getByText("encrypt-control")).toBeInTheDocument();
    expect(
      screen.getByText("security.encrypt_label").compareDocumentPosition(screen.getByText("security.advanced"))
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByText("security.duplicate_label")).not.toBeInTheDocument();
    expect(screen.getByTestId("loc")).toHaveTextContent("/daily");
    expect(screen.getByTestId("loc")).not.toHaveTextContent("legacyRo");
  });

  it("shows Encrypt disabled with honest copy when transitions are not allowed", async () => {
    renderPanel({ allowEncryptionTransitions: false });
    await openPanel();

    expect(screen.getByText("security.encrypt_label")).toBeInTheDocument();
    expect(screen.getByText("security.encrypt_helper_unavailable")).toBeInTheDocument();
    expect(screen.queryByText("security.encrypt_helper")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "security.encrypt_label" })).toBeDisabled();
    expect(screen.getByText("encrypt-control")).toBeInTheDocument();
    expect(screen.getByText("security.advanced")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "security.legacy_label" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "security.legacy_label" })).not.toBeDisabled();
    expect(
      screen.getByText("security.encrypt_label").compareDocumentPosition(screen.getByText("security.advanced"))
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("opens a first-time confirm dialog and leaves Legacy off on Cancel, Escape, and backdrop", async () => {
    renderPanel();
    await openPanel();
    await userEvent.click(screen.getByRole("switch", { name: "security.legacy_label" }));

    const dialog = await screen.findByTestId("legacy-opt-in-confirm");
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByText("security.legacy_confirm_title")).toBeInTheDocument();
    expect(within(dialog).getByText("security.legacy_confirm_body")).toBeInTheDocument();
    const cancel = within(dialog).getByRole("button", { name: "lock.cancel" });
    expect(cancel).toHaveFocus();

    await userEvent.click(cancel);
    await waitFor(() => {
      expect(screen.queryByTestId("legacy-opt-in-confirm")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("loc")).not.toHaveTextContent("legacyRo");

    await openPanel();
    expect(screen.getByRole("switch", { name: "security.legacy_label" })).toHaveAttribute("aria-checked", "false");
    await userEvent.click(screen.getByRole("switch", { name: "security.legacy_label" }));
    const again = await screen.findByTestId("legacy-opt-in-confirm");
    fireEvent.keyDown(again, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("legacy-opt-in-confirm")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("loc")).not.toHaveTextContent("legacyRo");

    await openPanel();
    await userEvent.click(screen.getByRole("switch", { name: "security.legacy_label" }));
    await screen.findByTestId("legacy-opt-in-confirm");
    const overlay = document.querySelector(".fixed.inset-0.z-50");
    expect(overlay).toBeTruthy();
    fireEvent.pointerDown(overlay!);
    await waitFor(() => {
      expect(screen.queryByTestId("legacy-opt-in-confirm")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("loc")).not.toHaveTextContent("legacyRo");
  });

  it("applies ?legacyRo=1 only after Turn on Legacy and persists the long-copy skip", async () => {
    renderPanel({ path: "/daily#owner=abc" });
    await openPanel();
    await userEvent.click(screen.getByRole("switch", { name: "security.legacy_label" }));
    const dialog = await screen.findByRole("dialog", { name: "security.legacy_confirm_title" });
    await userEvent.click(within(dialog).getByRole("button", { name: "security.legacy_confirm_turn_on" }));

    await waitFor(() => {
      expect(screen.getByTestId("loc")).toHaveTextContent("/daily?legacyRo=1#owner=abc");
    });
    expect(localStorage.getItem(legacyOptInConfirmStorageKey("daily"))).toBe("1");
  });

  it("uses the short confirm after the note has already confirmed once", async () => {
    markLegacyOptInConfirmed("daily");
    renderPanel();
    await openPanel();
    await userEvent.click(screen.getByRole("switch", { name: "security.legacy_label" }));
    const dialog = await screen.findByRole("dialog", { name: "security.legacy_confirm_title" });
    expect(within(dialog).getByText("security.legacy_confirm_body_short")).toBeInTheDocument();
    expect(within(dialog).queryByText("security.legacy_confirm_body")).not.toBeInTheDocument();
  });

  it("clears ?legacyRo=1 back to W1 editable when Legacy is turned off", async () => {
    renderPanel({ path: "/daily?legacyRo=1", legacyOn: true });
    await openPanel();
    expect(screen.getByText("security.legacy_helper_on")).toBeInTheDocument();
    const sw = screen.getByRole("switch", { name: "security.legacy_label" });
    expect(sw).not.toBeDisabled();
    await userEvent.click(sw);
    expect(screen.getByTestId("loc")).toHaveTextContent("/daily");
    expect(screen.getByTestId("loc")).not.toHaveTextContent("legacyRo");
  });

  it("disables switches and shows Loading… while busy", async () => {
    renderPanel({ loading: true });
    await openPanel();
    expect(screen.getByRole("switch", { name: "security.legacy_label" })).toBeDisabled();
    expect(screen.getByText("common.loading")).toBeInTheDocument();
  });

  it("hides owner-only controls in share-view and shows the owner copy", async () => {
    renderPanel({ ownerOnly: true });
    await openPanel();
    expect(screen.queryByRole("switch", { name: "security.legacy_label" })).not.toBeInTheDocument();
    expect(screen.queryByText("security.encrypt_label")).not.toBeInTheDocument();
    expect(screen.getByText("security.owner_only")).toBeInTheDocument();
  });

  it("omits Encrypt on plain Legacy RO chrome", async () => {
    renderPanel({
      path: "/daily",
      legacyOn: true,
      allowEncryptionTransitions: false,
    });
    await openPanel();
    expect(screen.queryByText("security.encrypt_label")).not.toBeInTheDocument();
    expect(screen.queryByText("encrypt-control")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "security.legacy_label" })).not.toBeDisabled();
    expect(screen.getByText("security.legacy_helper_on")).toBeInTheDocument();
  });

  it("turns Legacy off on plain RO back to W1 editable", async () => {
    renderPanel({ path: "/daily?legacyRo=1", legacyOn: true, allowEncryptionTransitions: false });
    await openPanel();
    const sw = screen.getByRole("switch", { name: "security.legacy_label" });
    expect(sw).not.toBeDisabled();
    await userEvent.click(sw);
    expect(screen.getByTestId("loc")).toHaveTextContent("/daily");
    expect(screen.getByTestId("loc")).not.toHaveTextContent("legacyRo");
  });

  it("applies ?legacyRo=1 from #owner= only after Turn on Legacy confirm", async () => {
    renderPanel({
      path: "/daily#owner=abc",
      capabilityAccess: { slug: "daily", scope: "owner", token: "a".repeat(43) },
    });
    await openPanel();
    const sw = screen.getByRole("switch", { name: "security.legacy_label" });
    expect(sw).not.toBeDisabled();
    expect(screen.getByText("security.legacy_helper_off")).toBeInTheDocument();
    await userEvent.click(sw);
    const dialog = await screen.findByTestId("legacy-opt-in-confirm");
    await userEvent.click(within(dialog).getByRole("button", { name: "security.legacy_confirm_turn_on" }));
    await waitFor(() => {
      expect(screen.getByTestId("loc")).toHaveTextContent("/daily?legacyRo=1#owner=abc");
    });
  });

  it("turns Legacy off from #owner= RO without a confirm", async () => {
    renderPanel({
      path: "/daily?legacyRo=1#owner=abc",
      legacyOn: true,
      capabilityAccess: { slug: "daily", scope: "owner", token: "a".repeat(43) },
    });
    await openPanel();
    expect(screen.getByText("security.legacy_helper_on")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "security.legacy_label" }));
    expect(screen.queryByRole("dialog", { name: "security.legacy_confirm_title" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("loc")).toHaveTextContent("/daily#owner=abc");
      expect(screen.getByTestId("loc")).not.toHaveTextContent("legacyRo");
    });
  });

  it("links the plain RO banner CTA to Home mint, not Duplicate or Enable Edit", () => {
    render(
      <MemoryRouter initialEntries={["/daily"]}>
        <LegacyRoBanner />
      </MemoryRouter>,
    );
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("security.legacy_banner");
    const cta = screen.getByRole("link", { name: "security.legacy_banner_cta" });
    expect(cta).toHaveAttribute("href", "/");
    expect(cta.className).toMatch(/min-h-11/);
    expect(cta.className).toMatch(/min-w-11/);
    expect(screen.queryByText("security.legacy_banner_open")).not.toBeInTheDocument();
    expect(screen.queryByText("security.duplicate_label")).not.toBeInTheDocument();
  });

  it("disables Legacy in split view so the other pane is not converted", async () => {
    renderPanel({ path: "/alpha+beta", slug: "alpha" });
    await openPanel();
    const sw = screen.getByRole("switch", { name: "security.legacy_label" });
    expect(sw).toBeDisabled();
    expect(screen.getByText("security.legacy_helper_split")).toBeInTheDocument();
    await userEvent.click(sw);
    expect(screen.queryByTestId("legacy-opt-in-confirm")).not.toBeInTheDocument();
    expect(screen.getByTestId("loc")).not.toHaveTextContent("legacyRo");
  });

  it("sizes security rows at least 44px", async () => {
    renderPanel();
    const trigger = screen.getByRole("button", { name: "security.panel_title" });
    expect(trigger.className).toMatch(/min-h-11/);
    expect(trigger.className).toMatch(/min-w-11/);
    await openPanel();
    const row = screen.getByTestId("security-legacy-row");
    expect(row.className).toMatch(/min-h-11/);
    expect(screen.getByRole("switch", { name: "security.legacy_label" }).className).toMatch(/h-11/);
  });

  it("hides Duplicate securely on default plain editable", async () => {
    renderPanel({
      path: "/daily",
      onDuplicateSecurely: () => {},
    });
    await openPanel();
    expect(screen.queryByText("security.duplicate_label")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "security.duplicate_label" })).not.toBeInTheDocument();
  });

  it("hides Duplicate securely on the editable capability path", async () => {
    renderPanel({
      path: "/daily#owner=abc",
      capabilityAccess: { slug: "daily", scope: "owner", token: "a".repeat(43) },
      onDuplicateSecurely: () => {},
    });
    await openPanel();
    expect(screen.queryByText("security.duplicate_label")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "security.duplicate_label" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "security.duplicate_label" })).not.toBeInTheDocument();
  });

  it("shows a clickable Duplicate securely CTA on Legacy RO, not a disabled switch", async () => {
    const onDuplicateSecurely = vi.fn();
    renderPanel({
      path: "/daily?legacyRo=1",
      legacyOn: true,
      allowEncryptionTransitions: false,
      onDuplicateSecurely,
    });
    await openPanel();

    expect(screen.getByText("security.duplicate_helper")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "security.duplicate_label" })).not.toBeInTheDocument();
    const cta = screen.getByRole("button", { name: "security.duplicate_label" });
    expect(cta).not.toBeDisabled();
    expect(cta.className).toMatch(/min-h-11/);
    expect(cta.className).toMatch(/min-w-11/);
    await userEvent.click(cta);
    expect(onDuplicateSecurely).toHaveBeenCalledOnce();
  });

  it("keeps Duplicate securely disabled until the note can be imported", async () => {
    renderPanel({
      path: "/daily",
      legacyOn: true,
      isEncrypted: true,
      allowEncryptionTransitions: false,
    });
    await openPanel();
    expect(screen.getByText("security.duplicate_helper_locked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "security.duplicate_label" })).toBeDisabled();
  });

  it("shows busy and fail copy without a forever-disabled switch", async () => {
    const onDuplicateSecurely = vi.fn();
    renderPanel({
      path: "/daily",
      legacyOn: true,
      onDuplicateSecurely,
      duplicateBusy: true,
    });
    await openPanel();
    expect(screen.getByText("security.duplicate_busy")).toBeInTheDocument();
    const busy = screen.getByRole("button", { name: "security.duplicate_busy" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("switch", { name: "security.duplicate_label" })).not.toBeInTheDocument();
    cleanup();

    renderPanel({
      path: "/daily",
      legacyOn: true,
      onDuplicateSecurely,
      duplicateFeedback: "network",
    });
    await openPanel();
    const fail = screen.getByRole("alert");
    expect(fail).toHaveTextContent("security.duplicate_fail");
    const retry = screen.getByRole("button", { name: "security.duplicate_retry" });
    expect(retry).not.toBeDisabled();
    expect(retry.className).toMatch(/min-h-11/);
    await userEvent.click(retry);
    expect(onDuplicateSecurely).toHaveBeenCalledOnce();
    cleanup();

    renderPanel({
      path: "/daily",
      legacyOn: true,
      onDuplicateSecurely,
      duplicateFeedback: "permission",
    });
    await openPanel();
    expect(screen.getByRole("alert")).toHaveTextContent("security.duplicate_fail_permission");
    expect(screen.getByRole("button", { name: "security.duplicate_retry" })).not.toBeDisabled();
  });
});
