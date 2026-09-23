import { describe, expect, it } from "vitest";
import { dict } from "@/i18n/catalog";
import { SUPPORTED_LANGS } from "@/i18n";

const KEYS = [
  "export.ai",
  "export.ai_tooltip",
  "toast.copied_ai",
  "toast.copied_ai_selection",
  "toast.copied_ai_desc",
] as const;

describe("Copy for AI i18n — Pixel VI/EN", () => {
  it("matches locked Vietnamese and English strings", () => {
    expect(dict.vi["export.ai"]).toBe("Copy nội dung cho AI");
    expect(dict.en["export.ai"]).toBe("Copy content for AI");
    expect(dict.vi["export.ai_tooltip"]).toBe(
      "Markdown đã làm sạch để dán vào ChatGPT/Claude — không gắn header slug",
    );
    expect(dict.en["export.ai_tooltip"]).toBe(
      "Cleaned markdown for ChatGPT/Claude — no slug header",
    );
    expect(dict.vi["toast.copied_ai"]).toBe("Đã copy nội dung cho AI");
    expect(dict.en["toast.copied_ai"]).toBe("Copied content for AI");
    expect(dict.vi["toast.copied_ai_selection"]).toBe("Đã copy vùng chọn cho AI");
    expect(dict.en["toast.copied_ai_selection"]).toBe("Copied selection for AI");
  });

  it("does not add out-of-scope long-warn or locked-tooltip keys", () => {
    const en = dict.en as Record<string, string>;
    expect(en["toast.copied_ai_long_desc"]).toBeUndefined();
    expect(en["export.ai_locked_tooltip"]).toBeUndefined();
  });

  it("defines the new keys in every locale with {n} on the token desc", () => {
    for (const lang of SUPPORTED_LANGS) {
      for (const key of KEYS) {
        expect(dict[lang][key], `${lang}/${key}`).toBeTruthy();
      }
      expect(dict[lang]["toast.copied_ai_desc"]).toContain("{n}");
    }
  });
});
