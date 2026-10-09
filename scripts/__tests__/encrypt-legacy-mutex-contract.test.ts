import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Create-bare + Encrypt≠owner + Legacy/Encrypt mutex", () => {
  it("never mints #owner= on Home create or Random", () => {
    const home = source("src/pages/Home.tsx");
    expect(home).toContain("seedAndOpen");
    expect(home).not.toContain("mintAndOpen");
    expect(home).not.toContain("mintCapabilityNote");
    expect(home).not.toContain("createNote");
    const availableAt = home.indexOf('status === "available"');
    expect(availableAt).toBeGreaterThan(0);
    const openAfter = home.slice(
      home.indexOf("openAfterStatusRef.current ="),
      home.indexOf("const open ="),
    );
    expect(openAfter).toContain('status === "available" || status === "taken"');
    expect(openAfter).toContain("seedAndOpen(trimmed)");
    expect(openAfter).not.toContain("mint");
    expect(home).toContain("seedAndOpen(randomSlug())");
  });

  it("temporarily disables encryption transitions and preserves security-panel wiring", () => {
    const notePage = source("src/pages/NotePage.tsx");
    expect(notePage).toContain("const allowEncryptionTransitions = false;");
    expect(notePage).not.toContain("allowEncryptionTransitions={!legacyContainment}");
    expect(notePage).toContain("allowEncryptionTransitions={allowEncryptionTransitions}");
  });

  it("wires panel XOR disable + mutex helpers", () => {
    const panel = source("src/components/note/NoteSecurityPanel.tsx");
    expect(panel).toContain("encryptLockedByLegacy");
    expect(panel).toContain("legacyLockedByEncrypt");
    expect(panel).toContain("security.encrypt_helper_mutex");
    expect(panel).toContain("security.legacy_helper_mutex");
    expect(panel).toContain("if (next && legacyLockedByEncrypt) return");
  });

  it("rejects convert-legacy when encrypted and set-encryption enable on managed", () => {
    const session = source("supabase/functions/note-session/index.ts");
    const convertAt = session.indexOf('if (body?.action === "convert-legacy")');
    const tokenHashAt = session.indexOf("const tokenHash = await capabilityTokenHash");
    const convert = session.slice(convertAt, tokenHashAt);
    expect(convert).toContain('if (isEncrypted === true) return capabilityFailure("invalid_state")');
    expect(convert).toContain('.from("notes")');
    expect(convert).toContain("is_encrypted");
    expect(convert).toContain('existing?.is_encrypted === true');
    expect(convert).toContain('return capabilityFailure("invalid_state")');
    expect(convert.match(/environment\.client\.rpc\(/g)).toHaveLength(2);

    const manage = source("supabase/functions/note-manage/index.ts");
    const setEncAt = manage.indexOf('action === "set-encryption"');
    const setEnc = manage.slice(setEncAt, manage.indexOf("} else {", setEncAt));
    expect(setEnc).toContain('if (isEncrypted === true) return capabilityFailure("invalid_state")');

    const edge = source("supabase/functions/_shared/capability-edge.ts");
    expect(edge).toContain('status === "invalid_state"');
    expect(edge).toContain('body("invalid state"), 409');
  });

  it("persists unmanaged encrypt through plain-upsert, not notes GRANTs", () => {
    const lock = source("src/components/note/LockButton.tsx");
    const lockNoteAt = lock.indexOf("const lockNote = async");
    const unlockNoteAt = lock.indexOf("const unlockNote = async");
    const unmanagedLock = lock.slice(lockNoteAt, unlockNoteAt);
    expect(unmanagedLock).toContain("upsertPlainNote");
    expect(unmanagedLock).toContain("isEncrypted: true");
    const unmanagedUnlock = lock.slice(unlockNoteAt, lock.indexOf("const encryptDialog"));
    expect(unmanagedUnlock).toContain("upsertPlainNote");
    expect(unmanagedUnlock).toContain("isEncrypted: false");
  });
});
