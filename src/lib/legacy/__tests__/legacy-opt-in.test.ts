import { afterEach, describe, expect, it } from "vitest";
import {
  buildLegacyOptInLocation,
  DUPLICATE_SECURELY_AVAILABLE,
  hasConfirmedLegacyOptIn,
  isLegacyRoSearch,
  legacyOptInConfirmStorageKey,
  markLegacyOptInConfirmed,
} from "../legacy-opt-in";

describe("legacy opt-in URL", () => {
  it("treats only legacyRo=1 as opted in", () => {
    expect(isLegacyRoSearch("")).toBe(false);
    expect(isLegacyRoSearch("?foo=1")).toBe(false);
    expect(isLegacyRoSearch("?legacyRo=0")).toBe(false);
    expect(isLegacyRoSearch("?legacyRo=1")).toBe(true);
    expect(isLegacyRoSearch("legacyRo=1")).toBe(true);
  });

  it("adds the opt-in without dropping other params or the fragment", () => {
    expect(buildLegacyOptInLocation("/daily", "", "", true)).toBe("/daily?legacyRo=1");
    expect(buildLegacyOptInLocation("/daily", "?x=1", "#owner=abc", true)).toBe(
      "/daily?x=1&legacyRo=1#owner=abc",
    );
  });

  it("removes only the opt-in and keeps capability fragments", () => {
    expect(buildLegacyOptInLocation("/daily", "?legacyRo=1", "#key", false)).toBe("/daily#key");
    expect(buildLegacyOptInLocation("/a+b", "?legacyRo=1&tab=1", "", false)).toBe("/a+b?tab=1");
  });

  it("does not rewrite a different slug's path", () => {
    expect(buildLegacyOptInLocation("/other", "?legacyRo=1", "", true)).toBe("/other?legacyRo=1");
  });
});

describe("legacy opt-in confirm persistence", () => {
  afterEach(() => localStorage.clear());

  it("is per-note and defaults to unconfirmed", () => {
    expect(hasConfirmedLegacyOptIn("daily")).toBe(false);
    markLegacyOptInConfirmed("daily");
    expect(hasConfirmedLegacyOptIn("daily")).toBe(true);
    expect(hasConfirmedLegacyOptIn("other")).toBe(false);
    expect(localStorage.getItem(legacyOptInConfirmStorageKey("daily"))).toBe("1");
  });
});

describe("Duplicate securely gate", () => {
  it("is on so Legacy RO can import via the cutover path", () => {
    expect(DUPLICATE_SECURELY_AVAILABLE).toBe(true);
  });
});
