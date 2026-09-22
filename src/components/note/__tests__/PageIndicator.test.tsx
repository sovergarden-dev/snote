import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PageIndicator } from "@/components/note/PageIndicator";
import { I18nProvider } from "@/i18n/provider";
import { STORAGE_KEY } from "@/i18n";

function renderIndicator() {
  return render(
    <I18nProvider>
      <PageIndicator page={1} totalPages={3} onPrev={() => {}} onNext={() => {}} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, "en");
});

afterEach(() => {
  cleanup();
});

describe("PageIndicator — FAB clearance", () => {
  it("uses the shared FAB disk token so hit targets stay left of the cluster", () => {
    renderIndicator();
    const el = screen.getByRole("status");
    expect(el.className).toMatch(/snote-page-indicator/);
    expect(el.className).not.toMatch(/\bright-4\b/);
    expect(el.className).not.toMatch(/\bbottom-4\b/);
    expect(el.className).toMatch(/z-40/);
  });
});
