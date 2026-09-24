import { describe, expect, it } from "vitest";
import {
  parseSplitSlugs,
  splitHasDuplicateSlugs,
  splitPaneKey,
  splitPaneTabLabel,
} from "../split-view";

describe("split-view URL helpers", () => {
  it("A1: keeps duplicate slug tokens", () => {
    expect(parseSplitSlugs("123+123")).toEqual(["123", "123"]);
    expect(splitHasDuplicateSlugs(["123", "123"])).toBe(true);
  });

  it("A2: keeps mixed duplicates", () => {
    expect(parseSplitSlugs("a+a+b")).toEqual(["a", "a", "b"]);
    expect(splitHasDuplicateSlugs(["a", "a", "b"])).toBe(true);
  });

  it("G1: distinct slugs are not duplicates", () => {
    expect(splitHasDuplicateSlugs(["a", "b"])).toBe(false);
  });
});

describe("split pane compact labels (E2/E3/G2)", () => {
  it("labels unique slugs without an ordinal", () => {
    expect(splitPaneTabLabel(["alpha", "beta"], 0)).toBe("/alpha");
    expect(splitPaneTabLabel(["alpha", "beta"], 1)).toBe("/beta");
  });

  it("labels duplicate slugs with 1-based ordinals", () => {
    expect(splitPaneTabLabel(["n", "n"], 0)).toBe("/n · 1");
    expect(splitPaneTabLabel(["n", "n"], 1)).toBe("/n · 2");
    expect(splitPaneTabLabel(["a", "a", "b"], 0)).toBe("/a · 1");
    expect(splitPaneTabLabel(["a", "a", "b"], 1)).toBe("/a · 2");
    expect(splitPaneTabLabel(["a", "a", "b"], 2)).toBe("/b");
  });

  it("uses pane index, never slug alone, for list keys", () => {
    expect(splitPaneKey(0)).toBe("pane-0");
    expect(splitPaneKey(1)).toBe("pane-1");
  });
});
