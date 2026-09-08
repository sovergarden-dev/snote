import { describe, expect, it } from "vitest";
import { dict } from "@/i18n/catalog";
import { SUPPORTED_LANGS } from "@/i18n";

const SECURITY_KEYS = [
  "security.panel_title",
  "security.encrypt_label",
  "security.encrypt_helper",
  "security.encrypt_helper_unavailable",
  "security.advanced",
  "security.legacy_label",
  "security.legacy_helper_off",
  "security.legacy_helper_on",
  "security.legacy_helper_capability",
  "security.legacy_helper_split",
  "security.duplicate_label",
  "security.duplicate_helper",
  "security.legacy_confirm_title",
  "security.legacy_confirm_body",
  "security.legacy_confirm_body_short",
  "security.legacy_confirm_turn_on",
  "security.legacy_banner",
  "security.legacy_banner_open",
  "security.owner_only",
] as const;

const BANNED = /temporarily unavailable|tạm thời không khả dụng/i;

describe("Note security panel i18n", () => {
  it("ships required English and Vietnamese copy", () => {
    expect(dict.en["security.panel_title"]).toBe("Note security");
    expect(dict.vi["security.panel_title"]).toBe("Bảo mật note");
    expect(dict.en["security.encrypt_label"]).toBe("Encrypt note");
    expect(dict.vi["security.encrypt_label"]).toBe("Mã hóa note");
    expect(dict.en["security.encrypt_helper_unavailable"]).toBe(
      "Encryption isn’t available on this note type. Use an owner link to encrypt.",
    );
    expect(dict.vi["security.encrypt_helper_unavailable"]).toBe(
      "Mã hóa chưa dùng được trên note dạng này. Dùng link owner để mã hóa.",
    );
    expect(dict.en["security.advanced"]).toBe("Advanced");
    expect(dict.vi["security.advanced"]).toBe("Nâng cao");
    expect(dict.en["security.legacy_label"]).toBe("Legacy format");
    expect(dict.vi["security.legacy_label"]).toBe("Định dạng Legacy");
    expect(dict.en["security.duplicate_label"]).toBe("Duplicate securely");
    expect(dict.vi["security.duplicate_label"]).toBe("Sao chép an toàn");
    expect(dict.en["security.duplicate_helper"]).toBe("Not available yet…");
    expect(dict.vi["security.duplicate_helper"]).toBe("Chưa mở…");
    expect(dict.en["security.legacy_helper_capability"]).toBe(
      "Not available on owner or edit links. Legacy format only opens table notes.",
    );
    expect(dict.vi["security.legacy_helper_capability"]).toBe(
      "Không dùng được trên link owner hoặc edit. Định dạng Legacy chỉ mở note dạng bảng.",
    );
    expect(dict.en["security.legacy_helper_split"]).toBe(
      "Not available in split view. It would change both notes.",
    );
    expect(dict.vi["security.legacy_helper_split"]).toBe(
      "Không dùng được trong chế độ chia đôi. Thao tác này sẽ đổi cả hai note.",
    );
    expect(dict.en["security.legacy_confirm_title"]).toBe("Turn on Legacy format?");
    expect(dict.vi["security.legacy_confirm_title"]).toBe("Bật định dạng Legacy?");
    expect(dict.en["security.legacy_confirm_turn_on"]).toBe("Turn on Legacy");
    expect(dict.vi["security.legacy_confirm_turn_on"]).toBe("Bật Legacy");
    expect(dict.en["security.legacy_banner"]).toMatch(/^Legacy note — view only/);
    expect(dict.vi["security.legacy_banner"]).toMatch(/^Note Legacy — chỉ xem/);
    expect(dict.en["lock.cancel"]).toBe("Cancel");
    expect(dict.vi["lock.cancel"]).toMatch(/Hủy|Huỷ/);
  });

  it("keeps every locale in sync and Vietnamese distinct from English", () => {
    for (const lang of SUPPORTED_LANGS) {
      for (const key of SECURITY_KEYS) {
        expect(dict[lang][key], `${lang}:${key}`).toBeTruthy();
        expect(dict[lang][key], `${lang}:${key}`).not.toMatch(BANNED);
      }
    }
    for (const key of SECURITY_KEYS) {
      expect(dict.vi[key], key).not.toBe(dict.en[key]);
    }
  });
});
