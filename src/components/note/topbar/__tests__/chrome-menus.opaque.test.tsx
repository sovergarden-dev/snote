import type { ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportMenu } from "@/components/note/topbar/ExportMenu";
import { ModeMenu } from "@/components/note/topbar/ModeMenu";
import { I18nProvider } from "@/i18n/provider";
import { STORAGE_KEY } from "@/i18n";

vi.mock("@/hooks/use-eink", () => ({
  useEink: () => ({ pref: "auto", setMode: vi.fn() }),
}));
vi.mock("@/hooks/use-vim-mode", () => ({
  useVimMode: () => ({ vim: false, toggleVim: vi.fn() }),
}));
vi.mock("@/hooks/use-toast", () => ({
  toast: vi.fn(),
  useToast: () => ({ toast: vi.fn(), dismiss: () => {}, toasts: [] }),
}));

function wrap(ui: ReactElement) {
  localStorage.setItem(STORAGE_KEY, "en");
  return render(<I18nProvider>{ui}</I18nProvider>);
}

describe("Mode / Export menus are opaque", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(STORAGE_KEY, "en");
  });

  afterEach(() => cleanup());

  it("paints Mode menu with an opaque surface", async () => {
    const user = userEvent.setup();
    wrap(
      <ModeMenu
        zen={false}
        onToggleZen={() => {}}
        typewriter={false}
        onToggleTypewriter={() => {}}
        focusLine={false}
        onToggleFocusLine={() => {}}
        paginated={false}
        onTogglePagination={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^Mode/ }));
    expect(screen.getByRole("menu")).toHaveClass("chrome-menu-surface");
    expect(screen.getByRole("menu")).toHaveClass("text-popover-foreground");
  });

  it("paints Export menu with an opaque surface", async () => {
    const user = userEvent.setup();
    wrap(
      <ExportMenu slug="demo" getContent={() => "# hi"} isEncrypted={false} />,
    );
    await user.click(screen.getByRole("button", { name: /^Export/ }));
    expect(screen.getByRole("menu")).toHaveClass("chrome-menu-surface");
    expect(screen.getByRole("menu")).toHaveClass("text-popover-foreground");
  });
});
