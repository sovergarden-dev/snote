import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const EXPECTED_BUN_VERSION = "1.3.14";
const ACTIONLINT_IMAGE =
  "docker://rhysd/actionlint@sha256:887a259a5a534f3c4f36cb02dca341673c6089431057242cdc931e9f133147e9";
const WORKFLOW_FILES = readdirSync(".github/workflows")
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => `.github/workflows/${name}`);
const workflows = new Map(
  WORKFLOW_FILES.map((path) => [
    path,
    readFileSync(path, "utf8").replaceAll("\r\n", "\n"),
  ]),
);
const allWorkflows = [...workflows.values()].join("\n");
const ci = workflows.get(".github/workflows/ci.yml")!;
const extensionWorkflow = workflows.get(".github/workflows/extension-e2e.yml")!;
const extensionAudit = readFileSync("scripts/audit-extension.sh", "utf8")
  .replaceAll("\r\n", "\n");
const bunLock = readFileSync("bun.lock", "utf8");
const securityFindings = readFileSync("docs/security-findings.md", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  packageManager?: string;
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  overrides?: Record<string, string>;
};
const toolsConfig = JSON.parse(readFileSync("tsconfig.tools.json", "utf8")) as {
  compilerOptions?: { strict?: boolean };
  include?: string[];
};

describe("CI toolchain contract", () => {
  it("pins one Bun version in package metadata and every workflow", () => {
    expect(packageJson.packageManager).toBe(`bun@${EXPECTED_BUN_VERSION}`);

    let setupCount = 0;
    for (const [path, workflow] of workflows) {
      const lines = workflow.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!/oven-sh\/setup-bun@/.test(line)) return;
        setupCount += 1;
        expect(
          line,
          `${path} setup-bun uses must be a 40-hex SHA pin`,
        ).toMatch(
          /uses:\s*oven-sh\/setup-bun@[0-9a-f]{40}(?:\s+#\s+\S+)?\s*$/,
        );
        expect(
          lines.slice(index, index + 4).join("\n"),
          `${path} setup-bun step must pin Bun ${EXPECTED_BUN_VERSION}`,
        ).toMatch(/bun-version:\s*["']?1\.3\.14["']?(?:\s|}|$)/);
      });
    }

    expect(setupCount).toBeGreaterThan(0);
    expect(allWorkflows).not.toMatch(/bun-version:\s*latest\b/);
    expect(allWorkflows).not.toContain("bun.lockb");
  });

  it("SHA-pins leftover JS GitHub Actions", () => {
    const leftover = [
      "actions/checkout",
      "oven-sh/setup-bun",
      "actions/upload-artifact",
    ] as const;

    for (const action of leftover) {
      const uses = [
        ...allWorkflows.matchAll(
          new RegExp(`^\\s*(?:-\\s+)?uses:\\s*${action}@\\S+`, "gm"),
        ),
      ].map((match) => match[0]);
      expect(uses.length, `${action} must appear in workflows`).toBeGreaterThan(
        0,
      );
      for (const use of uses) {
        expect(use, `${action} must be SHA-pinned`).toMatch(
          new RegExp(`${action}@[0-9a-f]{40}(?:\\s+#\\s+\\S+)?$`),
        );
      }
    }
  });

  it("keeps patched Vitest and its coverage provider aligned", () => {
    expect(packageJson.devDependencies.vitest).toBe("3.2.6");
    expect(packageJson.devDependencies["@vitest/coverage-v8"]).toBe("3.2.6");
    expect(packageJson.scripts["test:coverage"]).toBe("vitest run --coverage");
    expect(packageJson.overrides?.["test-exclude"]).toBe("8.0.0");
    expect(bunLock).toContain('"test-exclude": ["test-exclude@8.0.0"');
  });

  it("keeps the Workbox-only EJS build chain on the patched FileList line", () => {
    expect(packageJson.overrides?.filelist).toBe("2.0.2");
    expect(bunLock).toContain('"filelist": ["filelist@2.0.2"');

    const resolvedBraceExpansionVersions = [
      ...bunLock.matchAll(
        /"[^"]*brace-expansion": \["brace-expansion@([^"]+)"/g,
      ),
    ].map((match) => match[1]);
    expect(new Set(resolvedBraceExpansionVersions)).toEqual(new Set(["5.0.12"]));
  });

  it("records why Vite 5 cannot receive the required security fix", () => {
    expect(packageJson.devDependencies.vite).toBe("^6.4.3");
    expect(packageJson.overrides?.vite).toBe("^6.4.3");
    expect(securityFindings).toContain("GHSA-fx2h-pf6j-xcff");
    expect(securityFindings).toContain("there is no patched Vite 5 release");
  });

  it("pins the patched PostCSS security floor", () => {
    expect(packageJson.devDependencies.postcss).toBe("8.5.23");
    expect(packageJson.overrides?.postcss).toBe("8.5.23");
  });

  it("keeps knip's smol-toml on the GHSA-7w5x-hrqm-74c2 floor", () => {
    expect(packageJson.overrides?.["smol-toml"]).toBe("^1.7.1");
    expect(bunLock).toContain('"smol-toml": "^1.7.1"');
    expect(bunLock).not.toContain('"smol-toml": ["smol-toml@1.6.1"');
    expect(bunLock).not.toContain('"smol-toml": ["smol-toml@1.7.0"');
  });

  it("runs explicit app, node, tools, and edge TypeScript gates", () => {
    expect(ci).not.toMatch(/bunx tsc --noEmit\s*$/m);
    for (const project of ["app", "node", "tools"]) {
      expect(ci).toContain(`bunx tsc --noEmit -p tsconfig.${project}.json`);
    }
    expect(ci).toContain("bun run typecheck:edge");
  });

  it("covers scripts, e2e and configuration without forcing strict globally", () => {
    expect(toolsConfig.compilerOptions?.strict).toBe(false);
    expect(toolsConfig.include).toEqual(
      expect.arrayContaining([
        "scripts/**/*.ts",
        "e2e/**/*.ts",
        "e2e-extension/**/*.ts",
        "chrome-extension/**/*.ts",
        "vite.config.ts",
        "vitest.config.ts",
        "playwright.config.ts",
      ]),
    );
  });

  it("removes incompatible broad overrides", () => {
    for (const name of [
      "ajv",
      "esbuild",
      "glob",
      "minimatch",
      "@tootallnate/once",
      "brace-expansion",
    ]) {
      expect(packageJson.overrides ?? {}).not.toHaveProperty(name);
    }
  });

  it("cancels stale pull-request workflows", () => {
    const pullRequestWorkflows = [...workflows].filter(([, workflow]) =>
      /^  pull_request:/m.test(workflow),
    );
    expect(pullRequestWorkflows.length).toBeGreaterThan(0);

    for (const [path, workflow] of pullRequestWorkflows) {
      expect(workflow, path).toContain(
        "group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
      );
      expect(workflow, path).toMatch(/cancel-in-progress:\s*true\b/);
    }
  });

  it("keeps one stable quality gate with no duplicate unit run", () => {
    expect(ci).toMatch(/^\s{2}quality:\s*$/m);
    expect(ci).toMatch(/^\s{4}name:\s*quality\s*$/m);
    expect(ci).toContain(ACTIONLINT_IMAGE);
    expect(ci).toContain("persist-credentials: false");
    expect(ci).toContain("bash scripts/retry-bun-audit.sh");
    expect(ci).not.toMatch(/^[ \t]*-[ \t]+run:[ \t]*bun audit --audit-level=high[ \t]*$/m);
    expect(ci).toContain("bun run lint");
    expect(ci).toContain("bun run test:coverage");
    expect(ci).not.toMatch(/^[ \t]*(?:-[ \t]+)?run:[ \t]*bun run test[ \t]*$/m);
    expect(ci).toContain("bun run build:check");
  });

  it("keeps one stable PR E2E check context without blanket retries", () => {
    const e2ePrWorkflows = [...workflows]
      .filter(([, workflow]) => workflow.includes("\n  e2e-pr:\n"))
      .map(([path]) => path);
    expect(e2ePrWorkflows).toEqual([".github/workflows/ci.yml"]);
    expect(ci).toContain("e2e/critical-a11y.spec.ts");
    expect(ci).toContain("e2e/pwa-update-sw-stall.spec.ts");
    expect(ci).toContain("e2e/split-view-same-note.spec.ts");
    expect(ci).toContain("--retries=0");
    expect(ci).not.toContain("PLAYWRIGHT_RETRIES");
    expect(ci).toContain("VITE_SUPABASE_URL: https://ci.invalid");
    expect(ci).toContain(
      "VITE_SUPABASE_PUBLISHABLE_KEY: ci-public-placeholder",
    );
    expect(ci).not.toContain("secrets.VITE_SUPABASE");
  });

  it("runs extension verification for package-input pushes", () => {
    for (const path of [
      "package.json",
      "bun.lock",
      "scripts/audit-extension.sh",
      "scripts/retry-bun-audit.sh",
      "scripts/build-extension-zip.ts",
      "scripts/extension-archive.ts",
      "scripts/verify-extension-zip.ts",
      "scripts/verify-extension-zip.sh",
    ]) {
      expect(extensionWorkflow.split(`- "${path}"`).length - 1).toBe(1);
    }
  });

  it("uses the audit command supported by pinned Bun", () => {
    const retryAudit = readFileSync("scripts/retry-bun-audit.sh", "utf8")
      .replaceAll("\r\n", "\n");
    expect(retryAudit).toContain("bun audit --audit-level=high");
    expect(retryAudit).toContain("BUN_CONFIG_HTTP_IDLE_TIMEOUT=60");
    expect(retryAudit).toMatch(/MAX_ATTEMPTS=5\b/);
    expect(retryAudit).toContain("audit request failed");
    expect(retryAudit).not.toMatch(/bun audit[^\r\n]*--prod/);
    expect(retryAudit).not.toMatch(/bun pm (?:audit|scan)/);
    expect(extensionAudit).toContain("scripts/retry-bun-audit.sh");
    expect(allWorkflows).not.toContain("nick-fields/retry");
  });
});
