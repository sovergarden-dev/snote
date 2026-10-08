import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { CompanyFooter } from "@/components/CompanyFooter";
import { STORAGE_KEY, useI18n } from "@/i18n";
import { I18nProvider } from "@/i18n/provider";

function FooterHarness() {
  const { setLang } = useI18n();
  return (
    <>
      <button type="button" onClick={() => setLang("vi")}>
        Switch to Vietnamese
      </button>
      <CompanyFooter />
    </>
  );
}

function renderFooter() {
  return render(
    <I18nProvider>
      <FooterHarness />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, "en");
});

describe("CompanyFooter", () => {
  it("links to privacy and email, and localizes its copy when the language changes", async () => {
    renderFooter();

    expect(
      await screen.findByRole("contentinfo", {
        name: "Company and contact information",
      }),
    ).toBeInTheDocument();

    const privacyLink = screen.getByRole("link", { name: "Privacy" });
    expect(privacyLink).toHaveAttribute("href", "/privacy");
    expect(privacyLink).toHaveAttribute("title", "Read the privacy policy");

    const emailLink = screen.getByRole("link", { name: "syringa@syrin.online" });
    expect(emailLink).toHaveAttribute("href", "mailto:syringa@syrin.online");
    expect(emailLink).toHaveAttribute("title", "Email Syrin Notes");
    expect(screen.getByText("© 2026 Syrin")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Switch to Vietnamese" }));

    expect(
      await screen.findByText(
        "Syrin Notes được phát triển bởi Syrin · TP. Hồ Chí Minh, Việt Nam",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Quyền riêng tư" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(screen.getByRole("link", { name: "syringa@syrin.online" })).toBeInTheDocument();
  });
});
