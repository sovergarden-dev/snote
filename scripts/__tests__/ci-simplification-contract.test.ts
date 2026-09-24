import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const WORKFLOW_DIR = ".github/workflows";
const EXPECTED_WORKFLOWS = [
  "ci.yml",
  "extension-e2e.yml",
  "pwa-update-smoke-post-deploy.yml",
];
const EXPECTED_APP_E2E = [
  "critical-a11y.spec.ts",
  "install-prompt-a11y.spec.ts",
  "install-prompt-bip.spec.ts",
  "pwa-update-multi-click.spec.ts",
  "pwa-update-no-url-v-param.spec.ts",
  "pwa-update-sw-stall.spec.ts",
  "pwa-update-throttle.spec.ts",
  "split-view-malformed-persistence.spec.ts",
  "split-view-same-note.spec.ts",
  "theme-toggle-direct.spec.ts",
  "webgl-fallback.spec.ts",
];

const readWorkflow = (name: string) =>
  readFileSync(`${WORKFLOW_DIR}/${name}`, "utf8");

const trackedFiles = () =>
  execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);

describe("simplified delivery pipeline contract", () => {
  it("keeps exactly the three product workflows", () => {
    const workflows = readdirSync(WORKFLOW_DIR)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort();

    expect(workflows).toEqual(EXPECTED_WORKFLOWS);
  });

  it("runs one stable quality gate and a strict Chromium smoke on pull requests", () => {
    const ci = readWorkflow("ci.yml");

    expect(ci).toMatch(/^\s{2}quality:\s*$/m);
    expect(ci).toMatch(/^\s{4}name:\s*quality\s*$/m);
    expect(ci).toMatch(/^\s{2}e2e-pr:\s*$/m);
    expect(ci).toMatch(/^\s{4}name:\s*e2e-pr\s*$/m);
    expect(ci).toContain("github.event_name == 'pull_request'");
    expect(ci).toContain("--project=chromium");
    expect(ci).toContain("--retries=0");
    expect(ci).toContain("e2e/critical-a11y.spec.ts");
    expect(ci).toContain("e2e/pwa-update-sw-stall.spec.ts");
    expect(ci).toContain("e2e/split-view-same-note.spec.ts");
    expect(ci).toContain("VITE_SUPABASE_URL: https://ci.invalid");
    expect(ci).toContain(
      "VITE_SUPABASE_PUBLISHABLE_KEY: ci-public-placeholder",
    );
    expect(ci).not.toContain("secrets.VITE_SUPABASE");
  });

  it("runs the complete three-browser suite only outside pull requests", () => {
    const ci = readWorkflow("ci.yml");

    expect(ci).toMatch(/^\s{2}e2e-full:\s*$/m);
    expect(ci).toContain("github.event_name != 'pull_request'");
    expect(ci).toContain("browser: [chromium, firefox, webkit]");
    expect(ci).toContain("--project=${{ matrix.browser }}");
    expect(ci).toContain("--retries=0");
  });

  it("keeps one focused, non-duplicated app browser suite", () => {
    const specs = readdirSync("e2e")
      .filter((name) => name.endsWith(".spec.ts"))
      .sort();

    expect(specs).toEqual(EXPECTED_APP_E2E);
  });

  it("has no blanket retries, fixed sleeps, sticky comments, or schema-drift machinery", () => {
    const workflows = EXPECTED_WORKFLOWS.map(readWorkflow).join("\n");

    expect(workflows).not.toMatch(/--retries=[1-9]/);
    expect(workflows).not.toMatch(/\bsleep\s+\d/);
    expect(workflows).not.toMatch(
      /schema-drift|pretty-index|sticky[-_ ]comment|ci-sticky/i,
    );
  });

  it("uses condition-driven E2E waits and zero retries", () => {
    const e2eSources = trackedFiles()
      .filter(
        (file) =>
          existsSync(file) &&
          (file.startsWith("e2e/") || file.startsWith("e2e-extension/")) &&
          /\.(?:[cm]?[jt]sx?)$/.test(file),
      )
      .map((file) => `${file}\n${readFileSync(file, "utf8")}`)
      .join("\n");

    expect(e2eSources).not.toContain("waitForTimeout(");
    expect(e2eSources).not.toMatch(/\bretries\s*:\s*[1-9]\d*/);
    expect(e2eSources).not.toContain("helpers/seed-note");
    expect(e2eSources).not.toContain('process.env.VITE_SUPABASE');
  });

  it("gates dead files and dependencies in regular and production graphs", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const knipConfig = readFileSync("knip.json", "utf8");
    const ci = readWorkflow("ci.yml");

    expect(packageJson.scripts.knip).toContain(
      "--include files,dependencies,unlisted,unresolved",
    );
    expect(packageJson.scripts.knip).toContain("--production");
    expect(knipConfig).not.toContain("src/components/ui/**");
    expect(knipConfig).not.toContain("src/integrations/lovable/**");
    expect(ci).toContain("bun run knip");
  });

  it("keeps one failure artifact per E2E job instead of report fan-out", () => {
    for (const name of EXPECTED_WORKFLOWS) {
      const workflow = readWorkflow(name);
      expect(
        workflow.match(/uses:\s*actions\/upload-artifact@[0-9a-f]{40}/g) ?? [],
        name,
      ).toHaveLength(name === "ci.yml" ? 2 : 1);
      expect(workflow.match(/if:\s*(?:\$\{\{\s*)?failure\(\)/g) ?? []).toHaveLength(
        name === "ci.yml" ? 2 : 1,
      );
    }
  });

  it("does not commit generated reports, replay artifacts, bytecode, or vendored agent skills", () => {
    const files = trackedFiles();

    expect(files.some((file) => file.startsWith("artifacts/"))).toBe(false);
    expect(files.some((file) => file.startsWith("reports/"))).toBe(false);
    expect(files.some((file) => file.endsWith(".pyc"))).toBe(false);
    expect(files.some((file) => file.startsWith(".agents/"))).toBe(false);
    expect(existsSync(".agents")).toBe(false);
  });
});
