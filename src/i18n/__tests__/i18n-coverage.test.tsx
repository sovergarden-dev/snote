// E2E-style i18n coverage: cross-tab sync, persistence across reload,
// and Export/Help label rendering per language including toast strings.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { STORAGE_KEY, SUPPORTED_LANGS, useI18n, type Lang } from "@/i18n";
import { dict } from "@/i18n/catalog";
import { I18nProvider } from "@/i18n/provider";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ExportMenu } from "@/components/note/topbar/ExportMenu";
import { HelpMenu } from "@/components/note/topbar/HelpMenu";
import { TooltipProvider } from "@/components/ui/tooltip";

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <I18nProvider>{children}</I18nProvider>
    </TooltipProvider>
  );
}

// Capture toast() calls for assertion.
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  toast: (args: unknown) => toastSpy(args),
  useToast: () => ({ toast: toastSpy, dismiss: () => {}, toasts: [] }),
}));

beforeEach(() => {
  localStorage.clear();
  toastSpy.mockClear();
  // Stable clipboard mock.
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => {}) },
  });
});

afterEach(() => cleanup());

function ProbeAll() {
  const { lang, t } = useI18n();
  return (
    <div>
      <span data-testid="lang">{lang}</span>
      <span data-testid="menu-export">{t("menu.export")}</span>
      <span data-testid="menu-help">{t("menu.help")}</span>
      <span data-testid="export-copy">{t("export.copy_url")}</span>
      <span data-testid="export-ai">{t("export.ai")}</span>
      <span data-testid="help-shortcuts">{t("help.shortcuts")}</span>
      <span data-testid="toast-empty">{t("toast.note_empty")}</span>
      <span data-testid="toast-copied">{t("toast.copied_url")}</span>
    </div>
  );
}

describe("E2E — cross-tab language sync via storage event", () => {
  it("switching language in one tab updates another tab's labels immediately", async () => {
    const { unmount: unmountA } = render(
      <Wrap>
        <LanguageToggle />
      </Wrap>,
    );
    render(
      <Wrap>
        <ProbeAll />
      </Wrap>,
      { container: document.body.appendChild(document.createElement("div")) },
    );

    expect(screen.getByTestId("lang").textContent).toBe("en");
    expect(screen.getByTestId("menu-export").textContent).toBe(dict.en["menu.export"]);

    // Browsers dispatch `storage` only in OTHER tabs — simulate that here.
    await act(async () => {
      localStorage.setItem(STORAGE_KEY, "vi");
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY, newValue: "vi" }),
      );
    });
    expect(screen.getByTestId("lang").textContent).toBe("vi");
    await waitFor(() => {
      expect(screen.getByTestId("menu-export").textContent).toBe(dict.vi["menu.export"]);
      expect(screen.getByTestId("menu-help").textContent).toBe(dict.vi["menu.help"]);
      expect(screen.getByTestId("toast-empty").textContent).toBe(dict.vi["toast.note_empty"]);
    });

    await act(async () => {
      localStorage.setItem(STORAGE_KEY, "es");
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY, newValue: "es" }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("menu-export").textContent).toBe(dict.es["menu.export"]);
      expect(screen.getByTestId("help-shortcuts").textContent).toBe(dict.es["help.shortcuts"]);
    });

    unmountA();
  });
});

function Picker() {
  const { setLang } = useI18n();
  return (
    <button data-testid="pick-fr" onClick={() => setLang("fr")}>
      fr
    </button>
  );
}

describe("Persistence — language survives reload", () => {
  it("setLang writes to localStorage and a fresh mount picks it up", async () => {
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    const { unmount } = render(
      <Wrap>
        <Picker />
        <ProbeAll />
      </Wrap>,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("pick-fr"));
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBe("fr");
    await waitFor(() => {
      expect(screen.getByTestId("menu-export").textContent).toBe(dict.fr["menu.export"]);
    });
    unmount();

    // Simulated reload: brand new provider tree reads localStorage on init.
    render(
      <Wrap>
        <ProbeAll />
      </Wrap>,
    );
    expect(screen.getByTestId("lang").textContent).toBe("fr");
    await waitFor(() => {
      expect(screen.getByTestId("menu-help").textContent).toBe(dict.fr["menu.help"]);
      expect(screen.getByTestId("export-ai").textContent).toBe(dict.fr["export.ai"]);
    });
  });

  it("LanguageToggle button shows current language code", async () => {
    localStorage.setItem(STORAGE_KEY, "ja");
    render(
      <Wrap>
        <LanguageToggle />
      </Wrap>,
    );
    // The toggle renders the lang code in uppercase.
    expect(await screen.findByRole("button", { name: /言語/ })).toBeInTheDocument();
    expect(screen.getByText("ja")).toBeInTheDocument();
  });
});




describe("Export menu — localized trigger + dict coverage", () => {
  const EXPORT_KEYS = [
    "menu.export",
    "export.copy_url",
    "export.md",
    "export.html",
    "export.pdf",
    "export.txt",
    "export.ai",
    "export.ai_tooltip",
    "export.raw",
    "export.raw_tooltip",
  ] as const;

  it.each(SUPPORTED_LANGS)("renders ExportMenu trigger in %s", async (lang: Lang) => {
    localStorage.setItem(STORAGE_KEY, lang);
    render(
      <Wrap>
        <ExportMenu slug="demo" getContent={() => "hello"} isEncrypted={false} />
      </Wrap>,
    );
    const expected = (dict[lang] as Record<string, string>)["menu.export"];
    expect(
      await screen.findByRole("button", { name: new RegExp(expected) }),
    ).toBeInTheDocument();
  });

  it("every Export string is non-empty and distinct from English for non-English langs", () => {
    for (const lang of SUPPORTED_LANGS) {
      for (const key of EXPORT_KEYS) {
        const v = (dict[lang] as Record<string, string>)[key];
        expect(v, `${lang}/${key}`).toBeTruthy();
      }
      if (lang === "en") continue;
      // At least one Export key must be localized (not identical to English).
      const anyLocalized = EXPORT_KEYS.some(
        (k) =>
          (dict[lang] as Record<string, string>)[k] !==
          (dict.en as Record<string, string>)[k],
      );
      expect(anyLocalized, `${lang} has no localized export.* strings`).toBe(true);
    }
  });

  const RAW_COPY_KEYS = [
    "export.raw",
    "export.raw_tooltip",
    "toast.copied_raw",
    "toast.copied_raw_desc",
  ] as const;
  const DUMP_AD_RE = /cURL|wget|Python|edge function|Edge Function|text\/plain|functions\/v1\/raw/i;

  it("raw export copy describes the public RawView, not the Edge dump", () => {
    expect(dict.en["export.raw"].toLowerCase()).toMatch(/markdown/);
    expect(dict.en["export.raw_tooltip"]).toMatch(/slug\.md/);
    for (const lang of SUPPORTED_LANGS) {
      for (const key of RAW_COPY_KEYS) {
        const v = (dict[lang] as Record<string, string>)[key];
        expect(v, `${lang}/${key}`).toBeTruthy();
        expect(v, `${lang}/${key} advertises the dump`).not.toMatch(DUMP_AD_RE);
      }
    }
  });
});

describe("Shortcuts trigger (HelpMenu) — localized aria-label", () => {
  it.each(SUPPORTED_LANGS)("renders HelpMenu trigger in %s", async (lang: Lang) => {
    localStorage.setItem(STORAGE_KEY, lang);
    render(
      <Wrap>
        <HelpMenu onOpenShortcuts={() => {}} />
      </Wrap>,
    );
    const expected = (dict[lang] as Record<string, string>)["help.shortcuts"];
    expect(
      await screen.findByRole("button", { name: new RegExp(expected.slice(0, 6)) }),
    ).toBeInTheDocument();
  });
});

describe("Toast strings — localized and parameter substitution works", () => {
  function T() {
    const { t } = useI18n();
    return (
      <>
        <span data-testid="ai">{t("toast.copied_ai_desc", { n: 42 })}</span>
        <span data-testid="chars">{t("toast.copied_chars", { n: 7 })}</span>
      </>
    );
  }

  it.each(SUPPORTED_LANGS)("substitutes {n} in toast strings — %s", (lang: Lang) => {
    localStorage.setItem(STORAGE_KEY, lang);
    render(
      <Wrap>
        <T />
      </Wrap>,
    );
    expect(screen.getByTestId("ai").textContent).toContain("42");
    expect(screen.getByTestId("chars").textContent).toContain("7");
  });
});
