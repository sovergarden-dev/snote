import { describe, expect, it } from "vitest";
import { shouldHideDonateFab } from "@/lib/donate-fab-visibility";

describe("shouldHideDonateFab", () => {
  it("hides on /note and raw markdown paths only", () => {
    expect(shouldHideDonateFab("/note")).toBe(true);
    expect(shouldHideDonateFab("/daily.md")).toBe(true);
    expect(shouldHideDonateFab("/Foo.MD")).toBe(true);
    expect(shouldHideDonateFab("/")).toBe(false);
    expect(shouldHideDonateFab("/my-note")).toBe(false);
    expect(shouldHideDonateFab("/privacy")).toBe(false);
  });
});
