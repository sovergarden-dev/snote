import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGS } from "@/i18n";
import { dict } from "@/i18n/catalog";

const SRC = resolve(__dirname, "../../components/DonateButton.tsx");

function extractFabKeys(): string[] {
  const src = readFileSync(SRC, "utf8");
  const re = /["']fab\.([a-z0-9_.]+)["']/g;
  const set = new Set<string>();
  for (const m of src.matchAll(re)) set.add(`fab.${m[1]}`);
  return [...set].sort();
}

describe("DonateButton i18n key coverage", () => {
  it("references donate, status, aria, and snooze aria — not badge or Later chip copy", () => {
    const keys = extractFabKeys();
    expect(keys).toEqual(
      expect.arrayContaining([
        "fab.donate.aria",
        "fab.update.status",
        "fab.update.aria",
        "fab.update.snooze_aria",
      ]),
    );
    expect(keys).not.toContain("fab.update.badge");
    expect(keys).not.toContain("fab.update.snooze");
  });

  it("defines VI/EN status copy from Pixel LOCK and never uses NEW/Later as the chip", () => {
    expect(dict.vi["fab.update.status"]).toBe("Có update mới");
    expect(dict.en["fab.update.status"]).toBe("Update available");
    for (const lang of SUPPORTED_LANGS) {
      const status = dict[lang]["fab.update.status"];
      expect(status.length, lang).toBeGreaterThan(0);
      expect(status.toLowerCase(), lang).not.toBe("new");
      expect(status.toLowerCase(), lang).not.toBe("later");
    }
  });

  for (const lang of SUPPORTED_LANGS) {
    it(`locale "${lang}" defines every fab.* key used by DonateButton`, () => {
      const keys = extractFabKeys();
      const d = dict[lang] as Record<string, string>;
      const missing: string[] = [];
      const empty: string[] = [];
      for (const k of keys) {
        if (!(k in d)) missing.push(k);
        else if (typeof d[k] !== "string" || d[k].trim() === "") empty.push(k);
      }
      expect({ lang, missing, empty }).toEqual({ lang, missing: [], empty: [] });
    });
  }
});
