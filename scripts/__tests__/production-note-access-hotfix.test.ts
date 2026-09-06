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

describe("production note access hotfix", () => {
  it("keeps ordinary-note capability routing strictly opt-in", () => {
    const app = source("src/App.tsx");
    const envTypes = source("src/vite-env.d.ts");
    const envExample = source(".env.example");

    expect(app).toContain("const NotePage = lazy(() => loadNotePage());");
    expect(app).toMatch(
      /const capabilityRoutesEnabled\s*=\s*import\.meta\.env\.VITE_CAPABILITY_ROUTES_ENABLED === "true";/,
    );
    expect(app).toContain("<NotePage legacyOnly={!capabilityRoutesEnabled} />");
    expect(app).not.toContain("<NotePage legacyOnly />");
    expectValueImportBehindRoutesGuard(app, "./pages/CutoverNotePage");
    expect(app).toMatch(
      /capabilityRoutesEnabled\s*&&\s*CutoverNotePage\s*\?\s*\(\s*<CutoverNotePage\s*\/>/,
    );
    expect(app.match(/<SharePage legacyOnly=\{!capabilityRoutesEnabled\} \/>/g)).toHaveLength(2);
    expect(app).not.toMatch(/<SharePage\s*\/>/);
    expect(envTypes).toContain("readonly VITE_CAPABILITY_ROUTES_ENABLED?: string;");
    expect(envTypes).toContain("readonly VITE_CAPABILITY_AUTH_ENABLED?: string;");
    expect(envExample).toMatch(/^VITE_CAPABILITY_ROUTES_ENABLED=false$/m);
    expect(envExample).toMatch(/^VITE_CAPABILITY_AUTH_ENABLED=false$/m);

    const client = source("src/lib/capability/client.ts");
    const postAt = client.indexOf("const post = async");
    const flagCheckAt = client.indexOf(
      'import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED !== "true"',
      postAt,
    );
    const fetcherAt = client.indexOf("await fetcher(", postAt);
    expect(postAt).toBeGreaterThanOrEqual(0);
    expect(flagCheckAt).toBeGreaterThan(postAt);
    expect(fetcherAt).toBeGreaterThan(flagCheckAt);
    expect(client.slice(flagCheckAt, fetcherAt)).toContain("capability API unavailable");

    const auth = source("src/lib/capability/auth.ts");
    const defaultSource = auth.slice(auth.indexOf("export function createDefaultCapabilityAuthSource"));
    expect(defaultSource).toContain('import.meta.env.VITE_CAPABILITY_AUTH_ENABLED === "true"');
    expect(defaultSource).toContain('import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true"');
  });

  it("keeps SplitView on the legacy editor path and canary-gates Home mint plus LNO", () => {
    const split = source("src/pages/SplitView.tsx");
    const home = source("src/pages/Home.tsx");
    const raw = source("src/pages/RawView.tsx");

    expect(split).toContain("const NotePage = lazy(() => loadNotePage());");
    expect(split).toContain("legacyOnly");
    expectValueImportBehindRoutesGuard(split, "./CutoverNotePage");
    expect(split).toMatch(
      /capabilityRoutesEnabled\s*&&\s*CutoverNotePage\s*\?/,
    );
    expect(split).toContain("<CutoverNotePage");
    expect(split).toContain("embedSlug={slug}");
    expect(home).not.toContain('import("@/integrations/supabase/client")');
    expect(home).not.toContain('import { supabase } from "@/integrations/supabase/client";');
    expect(home).not.toMatch(
      /import\s*\{[^}]*createCapabilityApi[^}]*\}\s*from\s*["']@\/lib\/capability\/client["']/,
    );
    expect(withoutTypeImports(home)).toContain('import("@/lib/capability/client")');
    expectValueImportBehindRoutesGuard(home, "@/lib/capability/client");
    expectValueImportBehindRoutesGuard(home, "@/lib/legacy/cutover");
    expect(home).not.toContain("note-snapshot:");
    expect(raw).not.toContain('import { supabase } from "@/integrations/supabase/client";');
    expect(raw).not.toContain("integrations/supabase/client");
    expectValueImportBehindRoutesGuard(raw, "@/lib/legacy/cutover");
  });

  it("keeps Home's initial route off the knowledge-index graph", () => {
    const home = source("src/pages/Home.tsx");
    const staticFrom = (specifier: string) =>
      new RegExp(String.raw`from\s+["']${specifier}["']`);

    expect(home).not.toMatch(staticFrom("@/lib/note-index"));
    expect(home).not.toMatch(staticFrom("@/lib/home-library"));
    expect(home).not.toMatch(staticFrom("@/lib/note-templates"));
    expect(home).not.toMatch(staticFrom("@/lib/note-graph"));
    expect(home).not.toMatch(staticFrom("@/components/home/HomeTagFilter"));
    expect(home).not.toMatch(staticFrom("@/components/home/HomeCollections"));
    expect(home).not.toMatch(staticFrom("@/components/home/HomeTemplatePicker"));
    expect(home).not.toMatch(staticFrom("@/components/home/HomeLibraryPanel"));
    expect(home).not.toContain("hydrateNoteIndex");
    expect(home).not.toContain("getNoteIndexSnapshot");
    expect(home).not.toContain("subscribeNoteIndex");
    expect(home).toContain('lazy(() => import("@/components/home/HomeLibraryPanel"))');
    expect(home).toContain('lazy(() => import("@/components/home/HomeTemplatePicker"))');
    expect(home).toContain('import("@/lib/note-templates")');
    // fallback={null} lets the picker pop in above InstallPrompt and swallow the
    // first click (firefox BIP e2e). Keep a sized desktop slot so the trigger stays put.
    expect(home).not.toMatch(/<Suspense fallback=\{null\}>\s*<HomeTemplatePicker/);
    expect(home).toContain("sm:min-w-[22rem]");
    expect(source("src/components/home/HomeTemplatePicker.tsx")).toContain("sm:min-w-[22rem]");
  });

  it("keeps ShareDialog, LockButton, and LegacyNotePage off a static capability HTTP client import", () => {
    const staticCreateApi = /import\s*\{[^}]*createCapabilityApi[^}]*\}\s*from\s*["']@\/lib\/capability\/client["']/;
    const shareDialog = source("src/components/note/ShareDialog.tsx");
    const lockButton = source("src/components/note/LockButton.tsx");
    const legacyNotePage = source("src/pages/LegacyNotePage.tsx");

    expect(shareDialog).not.toMatch(staticCreateApi);
    expect(lockButton).not.toMatch(staticCreateApi);
    expect(legacyNotePage).not.toMatch(staticCreateApi);
    expect(shareDialog).toContain('import("@/lib/capability/client")');
    expect(lockButton).toContain('import("@/lib/capability/client")');
    expect(legacyNotePage).toContain('import("@/lib/capability/client")');
    expectValueImportBehindRoutesGuard(shareDialog, "@/lib/capability/client");
    expectValueImportBehindRoutesGuard(lockButton, "@/lib/capability/client");
    expectValueImportBehindRoutesGuard(legacyNotePage, "@/lib/capability/client");

    const revokeLink = shareDialog.slice(shareDialog.indexOf("const revokeLink"));
    const capabilityGuardAt = revokeLink.indexOf("if (capabilityAccess)");
    const shareRevokeAt = revokeLink.indexOf('supabase.functions.invoke("share-revoke"');
    expect(capabilityGuardAt).toBeGreaterThanOrEqual(0);
    expect(shareRevokeAt).toBeGreaterThan(capabilityGuardAt);
    expect(revokeLink.slice(0, capabilityGuardAt)).not.toContain("loadCapabilityApi");
    expect(revokeLink.slice(capabilityGuardAt, shareRevokeAt)).toContain("loadCapabilityApi");
    expect(revokeLink.slice(shareRevokeAt)).not.toContain("loadCapabilityApi");
  });

  it("keeps canary-off NotePage and SharePage chunks off a static capability HTTP client import", () => {
    const staticCreateApi = /import\s*\{[^}]*createCapabilityApi[^}]*\}\s*from\s*["']@\/lib\/capability\/client["']/;
    const staticCapabilityProvider =
      /import\s*\{[^}]*CapabilityYjsProvider[^}]*\}\s*from\s*["']@\/lib\/yjs\/capability-provider["']/;
    const notePage = source("src/pages/NotePage.tsx");
    const sharePage = source("src/pages/SharePage.tsx");
    const app = source("src/App.tsx");
    const split = source("src/pages/SplitView.tsx");
    const home = source("src/pages/Home.tsx");
    const raw = source("src/pages/RawView.tsx");

    expect(notePage).not.toMatch(staticCreateApi);
    expect(sharePage).not.toMatch(staticCreateApi);
    expect(home).not.toMatch(staticCreateApi);
    expect(notePage).not.toMatch(staticCapabilityProvider);
    expect(sharePage).not.toMatch(staticCapabilityProvider);
    expect(withoutTypeImports(notePage)).toContain('import("@/lib/capability/client")');
    expect(withoutTypeImports(sharePage)).toContain('import("@/lib/capability/client")');
    expect(withoutTypeImports(home)).toContain('import("@/lib/capability/client")');
    expect(withoutTypeImports(notePage)).toContain('import("@/lib/yjs/capability-provider")');
    expect(withoutTypeImports(sharePage)).toContain('import("@/lib/yjs/capability-provider")');
    expectValueImportBehindRoutesGuard(notePage, "@/lib/capability/client");
    expectValueImportBehindRoutesGuard(sharePage, "@/lib/capability/client");
    expectValueImportBehindRoutesGuard(home, "@/lib/capability/client");
    expectValueImportBehindRoutesGuard(notePage, "@/lib/yjs/capability-provider");
    expectValueImportBehindRoutesGuard(sharePage, "@/lib/yjs/capability-provider");
    expect(notePage).toContain("export function CutoverNotePage");
    expect(notePage).not.toMatch(
      /import\s+LegacyNotePage\s+from\s+["']@\/pages\/LegacyNotePage["']/,
    );
    expect(source("src/pages/CutoverNotePage.tsx")).toContain("export function CutoverNotePage");
    expectValueImportBehindRoutesGuard(app, "./pages/CutoverNotePage");
    expectValueImportBehindRoutesGuard(split, "./CutoverNotePage");
    expect(app).not.toMatch(
      /import\s+[^;]*CutoverNotePage[^;]*from\s+["'][^"']+["']/,
    );
    expect(split).not.toMatch(
      /import\s+[^;]*CutoverNotePage[^;]*from\s+["'][^"']+["']/,
    );
    expect(home).not.toContain("CutoverNotePage");
    expect(raw).not.toContain("CutoverNotePage");
  });

  it("keeps live share sanitizers off the legacy-note-open HTTP module", () => {
    const main = source("src/main.tsx");
    const sharePage = source("src/pages/SharePage.tsx");
    const sanitizer = source("src/lib/legacy/share-url.ts");
    const cutover = source("src/lib/legacy/cutover.ts");
    const notePage = source("src/pages/NotePage.tsx");
    const cutoverNotePage = source("src/pages/CutoverNotePage.tsx");
    const legacyNotePage = source("src/pages/LegacyNotePage.tsx");

    expect(sanitizer).not.toContain("legacy-note-open");
    expect(sanitizer).toContain("export function sanitizeLegacyShareUrl");
    expect(sanitizer).toContain("export function parseLegacyShareFragment");
    expect(sanitizer).toContain("export function legacyShareCutoffMs");
    expect(sanitizer).toContain("export function sanitizeLegacyShareLocation");

    expect(main).toContain('from "./lib/legacy/share-url"');
    expect(main).not.toContain("lib/legacy/cutover");
    expect(sharePage).toContain('from "@/lib/legacy/share-url"');
    expect(sharePage).not.toContain("@/lib/legacy/cutover");

    expect(cutover).toContain('"legacy-note-open"');
    expect(cutover).toContain("legacy-note-open");
    expect(notePage).not.toContain("@/lib/legacy/cutover");
    expectValueImportBehindRoutesGuard(notePage, "./CutoverNotePage");
    expectValueImportBehindRoutesGuard(cutoverNotePage, "./LegacyNotePage");
    expectValueImportBehindRoutesGuard(cutoverNotePage, "./NotePage");
    expect(cutoverNotePage).not.toMatch(
      /import\s+NotePage\s+from\s+["']@\/pages\/NotePage["']/,
    );
    expectValueImportBehindRoutesGuard(legacyNotePage, "@/lib/legacy/cutover");
    expectValueImportBehindRoutesGuard(source("src/pages/RawView.tsx"), "@/lib/legacy/cutover");
    expectValueImportBehindRoutesGuard(source("src/pages/Home.tsx"), "@/lib/legacy/cutover");
  });

  it("fail-closes the admin SPA unless VITE_ADMIN_PANEL_ENABLED is true", () => {
    const app = source("src/App.tsx");
    const envTypes = source("src/vite-env.d.ts");
    const envExample = source(".env.example");
    const panel = source("src/pages/AdminPanel.tsx");

    expect(app).toMatch(
      /const adminPanelEnabled\s*=\s*import\.meta\.env\.VITE_ADMIN_PANEL_ENABLED === "true";/,
    );
    expect(app).not.toContain(
      'const AdminPanel = lazy(() => import("./pages/AdminPanel"));',
    );
    const adminImportAt = app.indexOf('import("./pages/AdminPanel")');
    expect(adminImportAt).toBeGreaterThanOrEqual(0);
    expect(
      app.lastIndexOf(
        'import.meta.env.VITE_ADMIN_PANEL_ENABLED === "true"',
        adminImportAt,
      ),
    ).toBeGreaterThanOrEqual(0);
    expect(app).toMatch(
      /const AdminPanel\s*=\s*import\.meta\.env\.VITE_ADMIN_PANEL_ENABLED === "true"\s*\?\s*lazy\(\(\)\s*=>\s*import\("\.\/pages\/AdminPanel"\)\)\s*:\s*null;/,
    );

    const dispatcher = app.slice(app.indexOf("function SlugDispatcher"));
    const noteArmStart = dispatcher.indexOf('if (slug === "note")');
    const nextArmStart = dispatcher.indexOf("/\\.md$/i.test(slug)");
    expect(noteArmStart).toBeGreaterThanOrEqual(0);
    expect(nextArmStart).toBeGreaterThan(noteArmStart);
    const noteArm = dispatcher.slice(noteArmStart, nextArmStart);

    expect(noteArm).toContain("adminPanelEnabled");
    expect(noteArm.indexOf("adminPanelEnabled")).toBeLessThan(noteArm.indexOf("<AdminPanel"));
    expect(noteArm).toContain("<NotFound");
    expect(noteArm).not.toContain("NotePage");
    expect(noteArm).not.toContain("capabilityRoutesEnabled");
    expect(noteArm).not.toContain("VITE_CAPABILITY_ROUTES_ENABLED");

    expect(envTypes).toContain("readonly VITE_ADMIN_PANEL_ENABLED?: string;");
    expect(envExample).toMatch(/^VITE_ADMIN_PANEL_ENABLED=false$/m);

    const defaultExportAt = panel.indexOf("export default function AdminPanel");
    const flagCheckAt = panel.indexOf(
      'import.meta.env.VITE_ADMIN_PANEL_ENABLED !== "true"',
      defaultExportAt,
    );
    const notFoundAt = panel.indexOf("return <NotFound />", flagCheckAt);
    const firstEffectAt = panel.indexOf("useEffect", defaultExportAt);
    const firstInvokeAt = panel.indexOf("functions.invoke", defaultExportAt);
    const hashLoginAt = panel.indexOf("window.location.hash", defaultExportAt);
    expect(defaultExportAt).toBeGreaterThanOrEqual(0);
    expect(flagCheckAt).toBeGreaterThan(defaultExportAt);
    expect(notFoundAt).toBeGreaterThan(flagCheckAt);
    expect(firstEffectAt).toBeGreaterThan(notFoundAt);
    expect(firstInvokeAt).toBeGreaterThan(notFoundAt);
    expect(hashLoginAt).toBeGreaterThan(notFoundAt);
  });

  it("locks the default production bundle off admin invoke strings and the AdminPanel chunk", () => {
    const gate = source("scripts/check-bundle-size.ts");
    const pkg = source("package.json");

    expect(pkg).toContain('"build:check": "vite build && bun run scripts/check-bundle-size.ts"');
    expect(pkg).not.toMatch(/"build:check":\s*"vite build.*vite build/);
    expect(gate).toContain("ADMIN_SPA_INVOKE_STRINGS");
    expect(gate).toContain('"admin-session"');
    expect(gate).toContain('"admin-list"');
    expect(gate).toContain('"admin-delete"');
    expect(gate).toContain('"admin-rotate"');
    expect(gate).toContain("chunk-a8f3-");
    expect(gate).toMatch(
      /VITE_ADMIN_PANEL_ENABLED === ["']true["']/,
    );
    expect(gate).toContain("Admin SPA must not ship in default production JS");
  });

  it("locks the default production bundle off capability invoke strings", () => {
    const gate = source("scripts/check-bundle-size.ts");
    const pkg = source("package.json");

    expect(pkg).toContain('"build:check": "vite build && bun run scripts/check-bundle-size.ts"');
    expect(pkg).not.toMatch(/"build:check":\s*"vite build.*vite build/);
    expect(gate).toContain('"note-session"');
    expect(gate).toContain('"note-sync"');
    expect(gate).toContain('"note-manage"');
    expect(gate).toContain('"legacy-note-open"');
    expect(gate).toMatch(
      /VITE_CAPABILITY_ROUTES_ENABLED === ["']true["']/,
    );
    expect(gate).toContain("Capability HTTP client must not ship in default production JS");
    expect(gate).toContain("legacy-note-open must not ship in default production JS");
  });
});
