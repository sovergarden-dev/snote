import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("W1 convert-on-write contract", () => {
  it("routes default plain /slug to editable NotePage, not Cutover Legacy RO", () => {
    const cutover = source("src/pages/CutoverNotePage.tsx");
    const legacySearchAt = cutover.indexOf("if (isLegacyRoSearch(location.search))");
    const notePageAt = cutover.lastIndexOf("<NotePage");
    expect(legacySearchAt).toBeGreaterThan(0);
    expect(notePageAt).toBeGreaterThan(legacySearchAt);
    expect(cutover).not.toMatch(
      /isLegacyRoSearch\(location\.search\)\s*\|\|\s*!capabilityAccess/,
    );
    expect(cutover.slice(0, legacySearchAt)).not.toContain("return (");
    expect(cutover).toContain("<LegacyNotePage");
  });

  it("converts existing legacy through same-slug convert-legacy and empty notes through create", () => {
    const convert = source("src/lib/legacy/convert-on-write.ts");
    expect(convert).toContain("convertLegacyNote");
    expect(convert).toContain("duplicateLegacyNote");
    expect(convert).toContain("targetSlug: input.slug");
    expect(convert).toContain("mintCapabilityNote");
    expect(convert).toContain("input.api.createNote");
    expect(convert).not.toContain('from("notes")');
    expect(convert).not.toContain("SupabaseYjsProvider");
    expect(convert).not.toContain("integrations/supabase");
    expect(convert).not.toContain("capability_note_convert_legacy");
  });

  it("keeps canary plain persist off notes-table writes", () => {
    const notePage = source("src/pages/NotePage.tsx");
    const local = source("src/lib/yjs/local-convert-provider.ts");
    const convert = source("src/lib/legacy/convert-on-write.ts");

    expect(local).not.toContain('from("notes")');
    expect(local).not.toContain("integrations/supabase");
    expect(local).toContain("Never reads or writes `public.notes`");
    expect(convert).not.toContain('from("notes")');

    const canaryArm = notePage.indexOf(
      'else if (!legacyOnly && import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true")',
    );
    const notesArm = notePage.indexOf('.from("notes")');
    const localProviderAt = notePage.indexOf("new plainProviderCtor");
    const supabaseProviderAt = notePage.lastIndexOf("new SupabaseYjsProvider");
    expect(canaryArm).toBeGreaterThan(0);
    expect(notesArm).toBeGreaterThan(canaryArm);
    expect(localProviderAt).toBeGreaterThan(0);
    expect(supabaseProviderAt).toBeGreaterThan(localProviderAt);
    expect(notePage).toContain("createLegacyNoteApi().open");
    expect(notePage).toContain("convertPlainNoteOnWrite");
    expect(notePage).not.toContain("onDuplicateSecurely");

    const navigateAt = notePage.indexOf("navigate(path, { replace: true })");
    const successAt = notePage.indexOf('tRef.current("security.convert_success")');
    const failAt = notePage.indexOf('tRef.current("security.convert_fail")');
    expect(navigateAt).toBeGreaterThan(0);
    expect(successAt).toBeGreaterThan(navigateAt);
    expect(failAt).toBeGreaterThan(successAt);
  });

  it("shows Duplicate securely only on Legacy RO and lets Legacy off return to W1", () => {
    const panel = source("src/components/note/NoteSecurityPanel.tsx");
    expect(panel).not.toContain("legacyLockedOn");
    expect(panel).toContain("showDuplicate = DUPLICATE_SECURELY_AVAILABLE && showLegacy && legacyOn");
    expect(panel).toContain("applyLegacy(false)");
    expect(panel).toContain("isSplit");
    expect(source("src/pages/LegacyNotePage.tsx")).toContain("onDuplicateSecurely");
    expect(source("src/pages/NotePage.tsx")).not.toContain("onDuplicateSecurely");
  });
});
