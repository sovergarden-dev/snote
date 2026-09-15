import { afterEach, describe, expect, it, vi } from "vitest";
import { isUsableSlug } from "@/lib/slug";
import {
  LEGACY_SECURE_PIN_PREFIX,
  clearLegacySecurePin,
  clearPlainNoteIndexedDb,
  hasLegacySecurePin,
  legacySecurePinKey,
  markLegacySecurePin,
  plainNoteIndexedDbName,
} from "../legacy-secure-pin";

describe("Legacy ON session pin", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("stores a per-slug session pin and ignores reserved locators", () => {
    expect(LEGACY_SECURE_PIN_PREFIX).toBe("snote:legacy-secure:");
    expect(legacySecurePinKey("daily")).toBe("snote:legacy-secure:daily");
    expect(isUsableSlug("note")).toBe(false);

    expect(markLegacySecurePin("daily")).toBe(true);
    expect(sessionStorage.getItem("snote:legacy-secure:daily")).toBe("1");
    expect(hasLegacySecurePin("daily")).toBe(true);
    expect(hasLegacySecurePin("other")).toBe(false);
    expect(markLegacySecurePin("note")).toBe(false);
    expect(hasLegacySecurePin("note")).toBe(false);
    expect(sessionStorage.getItem("snote:legacy-secure:note")).toBeNull();
  });

  it("clears the pin on Legacy OFF", () => {
    expect(markLegacySecurePin("daily")).toBe(true);
    expect(clearLegacySecurePin("daily")).toBe(true);
    expect(hasLegacySecurePin("daily")).toBe(false);
    expect(sessionStorage.getItem("snote:legacy-secure:daily")).toBeNull();
  });

  it("deletes the plain y-indexeddb seed used by bare /slug", () => {
    const deleteDatabase = vi.fn();
    vi.stubGlobal("indexedDB", { deleteDatabase });

    expect(plainNoteIndexedDbName("daily")).toBe("note:daily");
    clearPlainNoteIndexedDb("daily");
    expect(deleteDatabase).toHaveBeenCalledWith("note:daily");
    deleteDatabase.mockClear();
    clearPlainNoteIndexedDb("note");
    expect(deleteDatabase).not.toHaveBeenCalled();
  });
});
