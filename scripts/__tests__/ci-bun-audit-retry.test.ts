import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = "scripts/retry-bun-audit.sh";

type Harness = {
  dir: string;
  attemptsFile: string;
  sleepArgsFile: string;
};

const harnesses: string[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    const dir = harnesses.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function writeExecutable(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function makeHarness(bunBody: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), "snote-bun-audit-retry-"));
  harnesses.push(dir);
  const attemptsFile = join(dir, "attempts");
  const sleepArgsFile = join(dir, "sleep-args");
  writeExecutable(
    join(dir, "bun"),
    bunBody
      .replaceAll("__ATTEMPTS__", attemptsFile)
      .replaceAll("__SLEEP_ARGS__", sleepArgsFile),
  );
  writeExecutable(
    join(dir, "sleep"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$(dirname "$0")/sleep-args"
`,
  );
  return { dir, attemptsFile, sleepArgsFile };
}

function runRetry(dir: string) {
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
  });
}

function attemptCount(attemptsFile: string) {
  try {
    return Number(readFileSync(attemptsFile, "utf8").trim() || "0");
  } catch {
    return 0;
  }
}

function sleepArgs(sleepArgsFile: string) {
  try {
    return readFileSync(sleepArgsFile, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const RECORD_ATTEMPT = `
n=0
if [[ -f "__ATTEMPTS__" ]]; then n=$(< "__ATTEMPTS__"); fi
n=$((n + 1))
printf '%s\\n' "$n" > "__ATTEMPTS__"
`;

const REQUIRE_AUDIT_ARGS = `
if [[ "$1" != "audit" || "$*" != "audit --audit-level=high --ignore=GHSA-vfj7-8cjw-p6xm" ]]; then
  printf 'unexpected bun invocation: %s\\n' "$*" >&2
  exit 99
fi
`;

describe("CI bun audit retry helper", () => {
  it("retries Timeout then succeeds without treating it as an advisory", () => {
    const { dir, attemptsFile, sleepArgsFile } = makeHarness(`#!/usr/bin/env bash
set -euo pipefail
${REQUIRE_AUDIT_ARGS}
${RECORD_ATTEMPT}
if [[ "$n" -lt 2 ]]; then
  echo "Timeout: audit request failed" >&2
  exit 1
fi
echo "No high or critical vulnerabilities found"
`);

    const result = runRetry(dir);

    expect(result.status).toBe(0);
    expect(attemptCount(attemptsFile)).toBe(2);
    expect(sleepArgs(sleepArgsFile)).toHaveLength(1);
    const delay = Number(sleepArgs(sleepArgsFile)[0]);
    expect(delay).toBeGreaterThanOrEqual(5);
    expect(delay).toBeLessThanOrEqual(15);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /Timeout: audit request failed/,
    );
  });

  it("retries ConnectionClosed up to five attempts then fails", () => {
    const { dir, attemptsFile, sleepArgsFile } = makeHarness(`#!/usr/bin/env bash
set -euo pipefail
${REQUIRE_AUDIT_ARGS}
${RECORD_ATTEMPT}
echo "ConnectionClosed: audit request failed" >&2
exit 1
`);

    const result = runRetry(dir);

    expect(result.status).not.toBe(0);
    expect(attemptCount(attemptsFile)).toBe(5);
    expect(sleepArgs(sleepArgsFile)).toHaveLength(4);
  });

  it("does not retry a real high-severity advisory", () => {
    const { dir, attemptsFile, sleepArgsFile } = makeHarness(`#!/usr/bin/env bash
set -euo pipefail
${REQUIRE_AUDIT_ARGS}
${RECORD_ATTEMPT}
echo "high: GHSA-mh99-v99m-4gvg prototype pollution in brace-expansion" >&2
exit 1
`);

    const result = runRetry(dir);

    expect(result.status).not.toBe(0);
    expect(attemptCount(attemptsFile)).toBe(1);
    expect(sleepArgs(sleepArgsFile)).toHaveLength(0);
  });

  it("does not retry a high finding whose title contains Timeout", () => {
    const { dir, attemptsFile, sleepArgsFile } = makeHarness(`#!/usr/bin/env bash
set -euo pipefail
${REQUIRE_AUDIT_ARGS}
${RECORD_ATTEMPT}
echo "high: Regular Expression Denial of Service in p-timeout" >&2
exit 1
`);

    const result = runRetry(dir);

    expect(result.status).not.toBe(0);
    expect(attemptCount(attemptsFile)).toBe(1);
    expect(sleepArgs(sleepArgsFile)).toHaveLength(0);
  });

  it("does not retry a non-advisory command error", () => {
    const { dir, attemptsFile, sleepArgsFile } = makeHarness(`#!/usr/bin/env bash
set -euo pipefail
${REQUIRE_AUDIT_ARGS}
${RECORD_ATTEMPT}
echo "error: lockfile not found" >&2
exit 1
`);

    const result = runRetry(dir);

    expect(result.status).not.toBe(0);
    expect(attemptCount(attemptsFile)).toBe(1);
    expect(sleepArgs(sleepArgsFile)).toHaveLength(0);
  });

  it("caps bun HTTP idle timeout so Timeout flakes stay inside the job budget", () => {
    const { dir } = makeHarness(`#!/usr/bin/env bash
set -euo pipefail
${REQUIRE_AUDIT_ARGS}
echo "idle=\${BUN_CONFIG_HTTP_IDLE_TIMEOUT:-}"
exit 0
`);

    const result = runRetry(dir);

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/idle=60\b/);
  });

  it("retries ECONNRESET, DNS, and bun-formatted 5xx registry errors", () => {
    const cases = [
      "error: ECONNRESET",
      "getaddrinfo ENOTFOUND registry.npmjs.org",
      "error: audit request failed (status 502)",
    ];

    for (const message of cases) {
      const { dir, attemptsFile } = makeHarness(`#!/usr/bin/env bash
set -euo pipefail
${REQUIRE_AUDIT_ARGS}
${RECORD_ATTEMPT}
if [[ "$n" -lt 2 ]]; then
  echo ${JSON.stringify(message)} >&2
  exit 1
fi
echo ok
`);
      const result = runRetry(dir);
      expect(result.status, message).toBe(0);
      expect(attemptCount(attemptsFile), message).toBe(2);
    }
  });
});
