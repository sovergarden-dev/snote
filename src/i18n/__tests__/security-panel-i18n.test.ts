import { describe, expect, it } from "vitest";
import { dict } from "@/i18n/catalog";
import { SUPPORTED_LANGS } from "@/i18n";

const SECURITY_KEYS = [
  "security.panel_title",
  "security.encrypt_label",
  "security.encrypt_helper",
  "security.encrypted_note_readonly",
  "security.encrypt_helper_unavailable",
  "security.encrypt_helper_mutex",
  "security.advanced",
  "security.legacy_label",
  "security.legacy_helper_off",
  "security.legacy_helper_on",
  "security.legacy_helper_on_plain",
  "security.legacy_helper_split",
  "security.legacy_helper_mutex",
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
  "security.legacy_secure_busy_on",
  "security.legacy_secure_busy_off",
  "security.legacy_secure_success_on",
  "security.legacy_secure_success_off",
  "security.legacy_secure_fail_on",
  "security.legacy_secure_fail_off",
  "security.legacy_secure_reopen_banner",
  "security.legacy_secure_reopen_cta",
  "security.legacy_confirm_title",
  "security.legacy_confirm_body",
  "security.legacy_confirm_body_short",
  "security.legacy_confirm_turn_on",
  "security.legacy_secure_label",
  "security.legacy_secure_helper_off",
  "security.legacy_secure_helper_on",
  "security.legacy_secure_confirm_title",
  "security.legacy_secure_confirm_body",
  "security.legacy_secure_confirm_body_short",
  "security.legacy_confirm_off_title",
  "security.legacy_confirm_off_body",
  "security.legacy_confirm_turn_off",
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
    expect(dict.en["security.encrypted_note_readonly"]).toBe(
      "This encrypted note is read-only; edits won't be saved. To keep the content, remove encryption or copy it into a new note.",
    );
    expect(dict.vi["security.encrypted_note_readonly"]).toBe(
      "Note đã mã hóa này ở chế độ chỉ đọc; thay đổi sẽ không được lưu. Để giữ nội dung, hãy gỡ mã hóa hoặc chép nội dung sang note mới.",
    );
    expect(dict.en["security.encrypt_helper_unavailable"]).toBe(
      "Encryption isn’t available on this note type. Use an owner link to encrypt.",
    );
    expect(dict.vi["security.encrypt_helper_unavailable"]).toBe(
      "Mã hóa chưa dùng được trên note dạng này. Dùng link owner để mã hóa.",
    );
    expect(dict.en["security.encrypt_helper_mutex"]).toBe(
      "Turn Legacy off before enabling encryption.",
    );
    expect(dict.vi["security.encrypt_helper_mutex"]).toBe(
      "Tắt Legacy trước khi bật mã hóa.",
    );
    expect(dict.en["security.legacy_helper_mutex"]).toBe(
      "Turn encryption off before enabling Legacy.",
    );
    expect(dict.vi["security.legacy_helper_mutex"]).toBe(
      "Tắt mã hóa trước khi bật Legacy.",
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
    expect(dict.en["security.legacy_secure_busy_on"]).toBe("Turning Legacy on…");
    expect(dict.vi["security.legacy_secure_busy_on"]).toBe("Đang bật Legacy…");
    expect(dict.en["security.legacy_secure_busy_off"]).toBe("Turning Legacy off…");
    expect(dict.vi["security.legacy_secure_busy_off"]).toBe("Đang tắt Legacy…");
    expect(dict.en["security.legacy_secure_success_on"]).toBe(
      "Legacy on. Keep the owner link to turn it off later.",
    );
    expect(dict.vi["security.legacy_secure_success_on"]).toBe(
      "Đã bật Legacy. Giữ link owner để tắt sau.",
    );
    expect(dict.en["security.legacy_secure_success_off"]).toBe(
      "Legacy off. Anyone with the link can edit.",
    );
    expect(dict.vi["security.legacy_secure_success_off"]).toBe(
      "Đã tắt Legacy. Ai có link cũng sửa được.",
    );
    expect(dict.en["security.legacy_secure_reopen_banner"]).toBe(
      "This note has Legacy on. Reopen it with the owner link (`#owner=`).",
    );
    expect(dict.vi["security.legacy_secure_reopen_banner"]).toBe(
      "Note đang bật Legacy. Mở lại bằng link owner (`#owner=`).",
    );
    expect(dict.en["security.legacy_secure_reopen_cta"]).toBe("Home");
    expect(dict.vi["security.legacy_secure_reopen_cta"]).toBe("Trang chủ");
    expect(dict.en["security.convert_busy"]).toBe("Turning Legacy on…");
    expect(dict.vi["security.convert_busy"]).toBe("Đang bật Legacy…");
    expect(dict.en["security.convert_success"]).toBe(
      "Legacy on. Keep the owner link to turn it off later.",
    );
    expect(dict.vi["security.convert_success"]).toBe(
      "Đã bật Legacy. Giữ link owner để tắt sau.",
    );
    expect(dict.en["security.convert_reopen_banner"]).toBe(
      "This note has Legacy on. Reopen it with the owner link (`#owner=`).",
    );
    expect(dict.vi["security.convert_reopen_banner"]).toBe(
      "Note đang bật Legacy. Mở lại bằng link owner (`#owner=`).",
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
    expect(dict.en["security.legacy_secure_label"]).toBe("Legacy (Secure)");
    expect(dict.vi["security.legacy_secure_label"]).toBe("Legacy (Bảo mật)");
    expect(dict.en["security.legacy_secure_helper_off"]).toMatch(/anyone who knows this slug can edit/i);
    expect(dict.vi["security.legacy_secure_helper_off"]).toMatch(/slug/);
    expect(dict.en["security.legacy_secure_helper_on"]).toMatch(/#owner=/);
    expect(dict.vi["security.legacy_secure_helper_on"]).toMatch(/#owner=/);
    expect(dict.en["security.legacy_secure_confirm_title"]).toBe("Turn on Legacy (Secure)?");
    expect(dict.vi["security.legacy_secure_confirm_title"]).toBe("Bật Legacy (Bảo mật)?");
    expect(dict.en["security.legacy_secure_confirm_body"]).toBe(
      "This turns Legacy on and replaces the URL with `#owner=`. Anyone with only the slug will not be able to edit.",
    );
    expect(dict.vi["security.legacy_secure_confirm_body"]).toBe(
      "Note sẽ bật Legacy và URL đổi thành `#owner=`. Ai chỉ có slug sẽ không sửa được.",
    );
    expect(dict.en["security.legacy_confirm_off_title"]).toBe("Turn off Legacy (Secure)?");
    expect(dict.vi["security.legacy_confirm_off_title"]).toBe("Tắt Legacy (Bảo mật)?");
    expect(dict.en["security.legacy_confirm_off_body"]).toBe(
      "This turns Legacy off. Anyone with the link can edit.",
    );
    expect(dict.vi["security.legacy_confirm_off_body"]).toBe(
      "Tắt Legacy. Ai có link cũng sửa được.",
    );
    expect(dict.en["security.legacy_confirm_turn_off"]).toBe("Turn off Legacy");
    expect(dict.vi["security.legacy_confirm_turn_off"]).toBe("Tắt Legacy");
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
    const bannedW1 = /Saving securely|Switched to a secure editable note|upgraded to a secure copy/i;
    for (const key of SECURITY_KEYS) {
      expect(dict.en[key], `en:${key}`).not.toMatch(bannedW1);
      expect(dict.vi[key], `vi:${key}`).not.toMatch(/Đang lưu an toàn|Đã chuyển sang note an toàn/);
    }
  });
});
