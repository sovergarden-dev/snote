/** @vitest-environment node */

import { describe, expect, it } from "vitest";
import {
  SPA_SHIP_GLOBS,
  decideRunSmoke,
  hasSpaShipChange,
  listPushChangedFiles,
} from "../spa-ship-globs";

/** Replay of squash-merge #142 / Actions run 35050846132. */
const SQL_DOCS_TYPES_ONLY = [
  "docs/security/bulk-disable-secure-ops.md",
  "scripts/__tests__/bulk-disable-secure-contract.test.ts",
  "scripts/__tests__/capability-backend-contract.test.ts",
  "scripts/__tests__/capability-migration.integration.test.ts",
  "src/integrations/supabase/types.ts",
  "supabase/migrations/20260916000000_capability_note_bulk_disable_secure.sql",
] as const;

describe("SPA_SHIP_GLOBS", () => {
  it("lists positive Pages SPA inputs and excludes generated SQL types", () => {
    expect([...SPA_SHIP_GLOBS]).toEqual([
      "src/App.tsx",
      "src/main.tsx",
      "src/index.css",
      "src/vite-env.d.ts",
      "src/assets/**",
      "src/components/**",
      "src/hooks/**",
      "src/i18n/**",
      "src/lib/**",
      "src/pages/**",
      "src/integrations/**",
      "!src/integrations/supabase/types.ts",
      "public/**",
      "index.html",
      "package.json",
      "bun.lock",
      "vite.config.ts",
      "tsconfig.json",
      "tsconfig.app.json",
      "tsconfig.node.json",
      "postcss.config.js",
      "tailwind.config.ts",
      "components.json",
      "scripts/build-release.ts",
      "scripts/release-identity.ts",
      ".env",
      ".env.example",
    ]);
  });
});

describe("hasSpaShipChange", () => {
  it("does not treat SQL + docs + script tests + generated types as SPA-ship", () => {
    expect(hasSpaShipChange(SQL_DOCS_TYPES_ONLY)).toBe(false);
    expect(
      hasSpaShipChange([
        "supabase/migrations/20260916000000_capability_note_bulk_disable_secure.sql",
        "docs/security/bulk-disable-secure-ops.md",
        "scripts/__tests__/bulk-disable-secure-contract.test.ts",
        "src/integrations/supabase/types.ts",
      ]),
    ).toBe(false);
  });

  it("still treats real SPA ship inputs as affecting Pages identity", () => {
    expect(hasSpaShipChange(["src/pages/NotePage.tsx"])).toBe(true);
    expect(hasSpaShipChange(["src/App.tsx"])).toBe(true);
    expect(hasSpaShipChange(["src/integrations/supabase/client.ts"])).toBe(true);
    expect(hasSpaShipChange(["public/sw.js"])).toBe(true);
    expect(
      hasSpaShipChange([
        "src/integrations/supabase/types.ts",
        "src/integrations/supabase/client.ts",
      ]),
    ).toBe(true);
    expect(
      hasSpaShipChange([
        ...SQL_DOCS_TYPES_ONLY,
        "src/pages/NotePage.tsx",
      ]),
    ).toBe(true);
  });
});

describe("listPushChangedFiles", () => {
  it("treats a missing or zero before SHA as unknown", () => {
    expect(listPushChangedFiles(undefined, "a".repeat(40))).toBe("unknown");
    expect(listPushChangedFiles("0".repeat(40), "a".repeat(40))).toBe("unknown");
    expect(listPushChangedFiles("a".repeat(40), undefined)).toBe("unknown");
  });
});

describe("decideRunSmoke", () => {
  it("always runs smoke for workflow_dispatch and deployment_status", () => {
    expect(decideRunSmoke("workflow_dispatch", SQL_DOCS_TYPES_ONLY)).toEqual({
      runSmoke: true,
      reason: "non-push event: run smoke",
    });
    expect(decideRunSmoke("deployment_status", SQL_DOCS_TYPES_ONLY)).toEqual({
      runSmoke: true,
      reason: "non-push event: run smoke",
    });
  });

  it("skips live SHA smoke on non-SPA main pushes", () => {
    expect(decideRunSmoke("push", SQL_DOCS_TYPES_ONLY)).toEqual({
      runSmoke: false,
      reason: "skip: no SPA-affecting paths",
    });
  });

  it("runs live SHA smoke when a SPA-ship path changes on push", () => {
    expect(decideRunSmoke("push", ["src/pages/NotePage.tsx"])).toEqual({
      runSmoke: true,
      reason: "SPA-ship paths changed",
    });
  });

  it("does not skip when the push before SHA is unknown", () => {
    expect(decideRunSmoke("push", "unknown")).toEqual({
      runSmoke: true,
      reason: "missing push before SHA: run smoke",
    });
  });
});
