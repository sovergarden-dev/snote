import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Topbar } from "../topbar/Topbar";
import type { CapabilityAccess } from "@/lib/capability/url";

const harness = vi.hoisted(() => ({
  shareDialogProps: vi.fn(),
  historyDialogProps: vi.fn(),
  topbarBrandProps: vi.fn(),
}));

vi.mock("@/components/ui/separator", () => ({ Separator: () => null }));
vi.mock("@/components/ShortcutHelp", () => ({ ShortcutHelp: () => null }));
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/SceneToggle", () => ({ SceneToggle: () => null }));
vi.mock("@/components/note/PresenceDots", () => ({ PresenceDots: () => null }));
vi.mock("@/components/note/HistoryDialog", () => ({
  HistoryDialog: (props: unknown) => {
    harness.historyDialogProps(props);
    return null;
  },
}));
vi.mock("@/components/note/NoteSecurityPanel", () => ({
  NoteSecurityPanel: () => <button type="button">Note security</button>,
  LegacyRoBanner: () => null,
}));
vi.mock("@/components/note/PinButton", () => ({ PinButton: () => null }));
vi.mock("@/components/note/WordGoalDialog", () => ({ WordGoalDialog: () => null }));
vi.mock("@/components/note/ShareDialog", () => ({
  ShareDialog: (props: unknown) => {
    harness.shareDialogProps(props);
    return null;
  },
}));
vi.mock("@/components/note/topbar/TopbarBrand", () => ({
  TopbarBrand: (props: unknown) => {
    harness.topbarBrandProps(props);
    return null;
  },
}));
vi.mock("@/components/note/topbar/WordCountTrigger", () => ({ WordCountTrigger: () => null }));
vi.mock("@/components/note/topbar/ViewControls", () => ({ ViewControls: () => null }));
vi.mock("@/components/note/topbar/ExportMenu", () => ({ ExportMenu: () => null }));
vi.mock("@/components/note/topbar/ModeMenu", () => ({ ModeMenu: () => null }));
vi.mock("@/components/note/topbar/HelpMenu", () => ({ HelpMenu: () => null }));
vi.mock("@/hooks/use-scene-theme", () => ({ useSceneTheme: () => ({ scene: "none" }) }));
vi.mock("@/hooks/use-narrow-viewport", () => ({ useNarrowViewport: () => false }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }));
vi.mock("@/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const ownerAccess: CapabilityAccess = {
  slug: "secret",
  scope: "owner",
  token: "a".repeat(43),
};

function renderTopbar(
  overrides: Partial<ComponentProps<typeof Topbar>> & { currentShareUrl?: string } = {},
) {
  const props: ComponentProps<typeof Topbar> = {
    slug: "secret",
    doc: new Y.Doc(),
    charCount: 0,
    wordCount: 0,
    users: [],
    showPreview: false,
    onTogglePreview: vi.fn(),
    scrollSync: false,
    onToggleScrollSync: vi.fn(),
    zen: false,
    onToggleZen: vi.fn(),
    typewriter: false,
    onToggleTypewriter: vi.fn(),
    focusLine: false,
    onToggleFocusLine: vi.fn(),
    getContent: () => "",
    isEncrypted: false,
    capabilityAccess: ownerAccess,
    paginated: false,
    onTogglePagination: vi.fn(),
    ...overrides,
  };

  return render(<Topbar {...props} />);
}

describe("Topbar encryption transitions", () => {
  beforeEach(() => {
    harness.shareDialogProps.mockClear();
    harness.historyDialogProps.mockClear();
    harness.topbarBrandProps.mockClear();
  });

  it("forwards the sanitized current share URL", () => {
    renderTopbar({ currentShareUrl: "https://example.test/secret#safe-key" });

    expect(harness.shareDialogProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ currentShareUrl: "https://example.test/secret#safe-key" }),
    );
  });

  it.each([
    ["wide", false],
    ["narrow", true],
  ])("keeps the security panel in the %s layout when encryption transitions are disabled", (_layout, narrowOverride) => {
    renderTopbar({ allowEncryptionTransitions: false, narrowOverride });

    expect(screen.getByRole("button", { name: "Note security" })).toBeInTheDocument();
  });

  it("keeps the owner security panel visible by default", () => {
    renderTopbar({ narrowOverride: false });

    expect(screen.getByRole("button", { name: "Note security" })).toBeInTheDocument();
  });

  it("keeps the owner security panel visible when transitions are explicitly enabled", () => {
    renderTopbar({ allowEncryptionTransitions: true, narrowOverride: true });

    expect(screen.getByRole("button", { name: "Note security" })).toBeInTheDocument();
  });

  it("keeps Legacy available on non-owner capability notes (view opt-in)", () => {
    renderTopbar({
      allowEncryptionTransitions: true,
      capabilityAccess: { ...ownerAccess, scope: "edit" },
    });

    expect(screen.getByRole("button", { name: "Note security" })).toBeInTheDocument();
  });

  it("does not expose slug-keyed legacy history to capability notes", () => {
    renderTopbar();

    expect(harness.historyDialogProps).not.toHaveBeenCalled();
    expect(harness.topbarBrandProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ onOpenHistory: undefined }),
    );
  });

  it("keeps slug-keyed history available to legacy notes", () => {
    renderTopbar({ capabilityAccess: null });

    expect(harness.historyDialogProps).toHaveBeenCalledTimes(1);
    expect(harness.topbarBrandProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ onOpenHistory: expect.any(Function) }),
    );
  });
});
