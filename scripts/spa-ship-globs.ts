import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** Positive Pages SPA ship inputs. Generated SQL types are excluded below. */
export const SPA_SHIP_GLOBS = [
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
] as const;

export type SmokeDecision = {
  runSmoke: boolean;
  reason: string;
};

const ZERO_SHA = "0".repeat(40);

/** Sequential GitHub Actions `paths` matching for this workflow's `*` / `**` / `!` subset (`?`, `+`, `[]` not modeled). */
function githubGlobToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (glob.startsWith("**", i)) {
      out += ".*";
      i += 2;
      continue;
    }
    if (glob[i] === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    out += glob[i]!.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`${out}$`);
}

export function githubPathsFilterMatches(
  patterns: readonly string[],
  changedFiles: readonly string[],
): boolean {
  return changedFiles.some((file) => {
    let included = false;
    for (const pattern of patterns) {
      const negated = pattern.startsWith("!");
      const glob = negated ? pattern.slice(1) : pattern;
      if (githubGlobToRegExp(glob).test(file)) {
        included = !negated;
      }
    }
    return included;
  });
}

export function hasSpaShipChange(changedFiles: readonly string[]): boolean {
  return githubPathsFilterMatches(SPA_SHIP_GLOBS, changedFiles);
}

export function decideRunSmoke(
  eventName: string,
  changedFiles: readonly string[] | "unknown",
): SmokeDecision {
  if (eventName !== "push") {
    return { runSmoke: true, reason: "non-push event: run smoke" };
  }
  if (changedFiles === "unknown") {
    return { runSmoke: true, reason: "missing push before SHA: run smoke" };
  }
  if (hasSpaShipChange(changedFiles)) {
    return { runSmoke: true, reason: "SPA-ship paths changed" };
  }
  return { runSmoke: false, reason: "skip: no SPA-affecting paths" };
}

export function listPushChangedFiles(
  beforeSha: string | undefined,
  afterSha: string | undefined,
  git: (args: readonly string[]) => string = runGit,
): readonly string[] | "unknown" {
  if (!beforeSha || beforeSha === ZERO_SHA || !afterSha) {
    return "unknown";
  }
  return git(["diff", "--name-only", beforeSha, afterSha])
    .split(/\r?\n/)
    .filter(Boolean);
}

function runGit(args: readonly string[]): string {
  return execFileSync("git", [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeRunSmoke(decision: SmokeDecision): void {
  const value = decision.runSmoke ? "true" : "false";
  console.log(decision.reason);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, `run_smoke=${value}\n`);
  }
}

if (import.meta.main) {
  try {
    const eventName = process.env.EVENT_NAME ?? "";
    const changedFiles = eventName === "push"
      ? listPushChangedFiles(process.env.BEFORE_SHA, process.env.AFTER_SHA)
      : [];
    writeRunSmoke(decideRunSmoke(eventName, changedFiles));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "SPA-ship path detect failed.",
    );
    process.exitCode = 1;
  }
}
