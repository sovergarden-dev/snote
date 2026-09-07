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
  it("references badge, aria, donate, and snooze keys", () => {
    const keys = extractFabKeys();
    expect(keys).toEqual(
      expect.arrayContaining([
        "fab.donate.aria",
        "fab.update.badge",
        "fab.update.aria",
        "fab.update.snooze",
        "fab.update.snooze_aria",
      ]),
    );
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
