import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const ROUTES_TRUE =
  'import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true"';

const withoutTypeImports = (src: string) => src.replace(/typeof import\([^)]*\)/g, "");

function expectValueImportBehindRoutesGuard(src: string, specifier: string) {
  const valueSrc = withoutTypeImports(src);
  let from = 0;
  let found = 0;
  while (true) {
    const importAt = valueSrc.indexOf(`import("${specifier}")`, from);
    if (importAt < 0) break;
    found += 1;
    expect(valueSrc.lastIndexOf(ROUTES_TRUE, importAt)).toBeGreaterThanOrEqual(0);
    from = importAt + 1;
  }
  expect(found).toBeGreaterThan(0);
}

describe("Phase C canary client notes-table pin", () => {
  it("forbids .from(\"notes\") in RawView and Home", () => {
    const raw = source("src/pages/RawView.tsx");
    const home = source("src/pages/Home.tsx");

    expect(raw).not.toContain('.from("notes")');
    expect(raw).not.toContain(".from('notes')");
    expect(raw).not.toContain("integrations/supabase/client");
    expect(raw).not.toMatch(
      /import\s*\{[^}]*createLegacyNoteApi[^}]*\}\s*from\s*["']@\/lib\/legacy\/cutover["']/,
    );
    expect(withoutTypeImports(raw)).toContain('import("@/lib/legacy/cutover")');
    expect(raw).toContain(".open(");
    expectValueImportBehindRoutesGuard(raw, "@/lib/legacy/cutover");

    expect(home).not.toContain('.from("notes")');
    expect(home).not.toContain(".from('notes')");
    expect(home).not.toContain("integrations/supabase/client");
    expect(home).not.toMatch(
      /import\s*\{[^}]*createLegacyNoteApi[^}]*\}\s*from\s*["']@\/lib\/legacy\/cutover["']/,
    );
    expect(withoutTypeImports(home)).toContain('import("@/lib/legacy/cutover")');
    expect(home).toMatch(/\.exists\(/);
    expectValueImportBehindRoutesGuard(home, "@/lib/legacy/cutover");
  });
});
