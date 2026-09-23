import type { ButtonHTMLAttributes, ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportMenu } from "@/components/note/topbar/ExportMenu";
import { approxTokens, cleanForAI } from "@/lib/ai-format";
import { dict } from "@/i18n/catalog";
import { I18nProvider } from "@/i18n/provider";
import { STORAGE_KEY } from "@/i18n";

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  toast: (args: unknown) => toastSpy(args),
  useToast: () => ({ toast: toastSpy, dismiss: () => {}, toasts: [] }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const writeText = vi.fn(async () => {});

function Wrap({ children }: { children: React.ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}

function renderMenu(
  overrides: {
    slug?: string;
    getContent?: () => string;
    getEditorSelection?: () => string;
    isEncrypted?: boolean;
  } = {},
) {
  return render(
    <Wrap>
      <ExportMenu
        slug={overrides.slug ?? "demo-slug"}
        getContent={overrides.getContent ?? (() => "# Hello\n\nfull note")}
        getEditorSelection={overrides.getEditorSelection}
        isEncrypted={overrides.isEncrypted ?? false}
      />
    </Wrap>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, "en");
  toastSpy.mockClear();
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => cleanup());

describe("ExportMenu Copy for AI", () => {
  it("copies cleaned markdown with no slug header on the full-note path", async () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: dict.en["export.ai"] }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls.at(0)?.at(0));
    expect(copied).toBe(cleanForAI("# Hello\n\nfull note"));
    expect(copied).not.toMatch(/# Note:\s*\//);
    expect(copied).not.toContain("demo-slug");
    expect(toastSpy).toHaveBeenCalledWith({
      title: dict.en["toast.copied_ai"],
      description: dict.en["toast.copied_ai_desc"].replace(
        "{n}",
        String(approxTokens(copied)),
      ),
    });
  });

  it("copies the cleaned editor selection only and uses the selection toast title", async () => {
    renderMenu({
      getEditorSelection: () => "picked <!-- x --> bits",
    });
    fireEvent.click(screen.getByRole("button", { name: dict.en["export.ai"] }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(cleanForAI("picked <!-- x --> bits"));
    const copied = String(writeText.mock.calls.at(0)?.at(0));
    expect(copied).toBe("picked  bits");
    expect(toastSpy).toHaveBeenCalledWith({
      title: dict.en["toast.copied_ai_selection"],
      description: dict.en["toast.copied_ai_desc"].replace(
        "{n}",
        String(approxTokens(copied)),
      ),
    });
  });

  it("treats whitespace-only selection as the full-note path", async () => {
    renderMenu({
      getEditorSelection: () => "  \n\t  ",
    });
    fireEvent.click(screen.getByRole("button", { name: dict.en["export.ai"] }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(cleanForAI("# Hello\n\nfull note"));
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: dict.en["toast.copied_ai"] }),
    );
  });

  it("ignores window.getSelection chrome text when the editor has no selection", async () => {
    const getSelection = vi.fn(() => ({ toString: () => "CHROME UI" }));
    vi.stubGlobal("getSelection", getSelection);

    renderMenu({ getEditorSelection: () => "" });
    fireEvent.click(screen.getByRole("button", { name: dict.en["export.ai"] }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls.at(0)?.at(0))).not.toContain("CHROME UI");
    expect(writeText).toHaveBeenCalledWith(cleanForAI("# Hello\n\nfull note"));
    vi.unstubAllGlobals();
  });

  it("keeps the empty full-note toast and does not write the clipboard", async () => {
    renderMenu({ getContent: () => "", getEditorSelection: () => "" });
    fireEvent.click(screen.getByRole("button", { name: dict.en["export.ai"] }));

    expect(writeText).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith({ title: dict.en["toast.note_empty"] });
  });

  it("exposes the Pixel tooltip on the AI item and keeps Sparkles in source", () => {
    renderMenu();
    expect(screen.getByRole("button", { name: dict.en["export.ai"] })).toHaveAttribute(
      "title",
      dict.en["export.ai_tooltip"],
    );
    const src = readFileSync(resolve(__dirname, "../topbar/ExportMenu.tsx"), "utf8");
    expect(src).toMatch(/Sparkles/);
    expect(src).not.toMatch(/formatForAI/);
    expect(src).not.toMatch(/window\.getSelection/);
  });
});

describe("ExportMenu AI copy wiring", () => {
  it("Topbar forwards editor selection into ExportMenu", () => {
    const src = readFileSync(resolve(__dirname, "../topbar/Topbar.tsx"), "utf8");
    expect(src).toMatch(/getEditorSelection=\{getEditorSelection\}/);
  });

  it("NotePage reads selection from the note editor handle on both mounts", () => {
    const src = readFileSync(resolve(__dirname, "../../../pages/NotePage.tsx"), "utf8");
    expect(src).toMatch(/getSelectedText/);
    expect(src.match(/ref=\{editorRef\}/g)?.length).toBe(2);
  });
});
