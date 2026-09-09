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
  "security.legacy_helper_on_plain",
  "security.legacy_helper_split",
  "security.duplicate_label",
  "security.duplicate_helper",
  "security.duplicate_helper_locked",
  "security.duplicate_busy",
  "security.duplicate_success",
  "security.duplicate_fail",
  "security.duplicate_fail_permission",
  "security.duplicate_retry",
  "security.convert_busy",
  "security.convert_success",
  "security.convert_fail",
  "security.convert_retry",
  "security.convert_reopen_banner",
  "security.convert_reopen_cta",
  "security.legacy_confirm_title",
  "security.legacy_confirm_body",
  "security.legacy_confirm_body_short",
  "security.legacy_confirm_turn_on",
  "security.legacy_banner",
  "security.legacy_banner_cta",
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
    expect(dict.en["security.duplicate_helper"]).toBe(
      "Creates a new editable note from this view-only Legacy note.",
    );
    expect(dict.vi["security.duplicate_helper"]).toBe(
      "Tạo note mới có quyền sửa từ bản Legacy chỉ xem này.",
    );
    expect(dict.en["security.duplicate_busy"]).toBe("Duplicating…");
    expect(dict.vi["security.duplicate_busy"]).toBe("Đang sao chép…");
    expect(dict.en["security.duplicate_success"]).toBe("Copy created. Opening the new note.");
    expect(dict.vi["security.duplicate_success"]).toBe("Đã tạo bản sao. Đang mở note mới.");
    expect(dict.en["security.duplicate_fail"]).toBe(
      "Couldn't duplicate this note. Check your connection and try again.",
    );
    expect(dict.vi["security.duplicate_fail"]).toBe(
      "Không sao chép được note này. Kiểm tra kết nối rồi thử lại.",
    );
    expect(dict.en["security.duplicate_fail_permission"]).toBe(
      "Couldn't duplicate. You don't have permission to duplicate this note.",
    );
    expect(dict.vi["security.duplicate_fail_permission"]).toBe(
      "Không sao chép được. Bạn không có quyền sao chép note này.",
    );
    expect(dict.en["security.duplicate_retry"]).toBe("Retry");
    expect(dict.vi["security.duplicate_retry"]).toBe("Thử lại");
    expect(dict.en["security.convert_busy"]).toBe("Saving securely…");
    expect(dict.vi["security.convert_busy"]).toBe("Đang lưu an toàn…");
    expect(dict.en["security.convert_success"]).toBe("Switched to a secure editable note");
    expect(dict.vi["security.convert_success"]).toBe("Đã chuyển sang note an toàn");
    expect(dict.en["security.convert_reopen_banner"]).toBe(
      "This note was upgraded to a secure copy. Reopen it with your owner link (`#owner=`).",
    );
    expect(dict.vi["security.convert_reopen_banner"]).toBe(
      "Note này đã chuyển sang bản an toàn. Mở lại từ link owner (`#owner=`).",
    );
    expect(dict.en["security.convert_reopen_cta"]).toBe("Home");
    expect(dict.vi["security.convert_reopen_cta"]).toBe("Trang chủ");
    expect(dict.en["security.legacy_helper_on_plain"]).toMatch(/view-only/);
    expect(dict.vi["security.legacy_helper_on_plain"]).toMatch(/chỉ xem/);
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
    expect(dict.en["security.legacy_banner"]).toBe(
      "View only. Create an editable copy from Home.",
    );
    expect(dict.vi["security.legacy_banner"]).toBe(
      "Note chỉ xem. Tạo bản chỉnh sửa từ Trang chủ.",
    );
    expect(dict.en["security.legacy_banner_cta"]).toBe("Create editable note");
    expect(dict.vi["security.legacy_banner_cta"]).toBe("Tạo bản chỉnh sửa");
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
