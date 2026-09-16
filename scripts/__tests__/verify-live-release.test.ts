/** @vitest-environment node */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { githubPathsFilterMatches } from "../spa-ship-globs";
import {
  verifyLiveRelease,
  waitForLiveRelease,
  type FetchLike,
  type LiveReleaseInput,
} from "../verify-live-release";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const validInput: LiveReleaseInput = {
  baseUrl: "https://note.syrin.online",
  expectedSha: SHA,
  expectedCapabilityRoutesEnabled: "false",
};

function manifestResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "private, no-store");
  }
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status: 200, ...init, headers },
  );
}

function recordingFetch(response: Response): {
  fetchImpl: FetchLike;
  calls: Array<{ url: URL; init: RequestInit }>;
} {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response;
    },
  };
}

async function rejectionMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error("Expected operation to reject");
}

describe("live release attestation", () => {
  it("accepts the exact SHA and disabled capability state", async () => {
    const { fetchImpl, calls } = recordingFetch(manifestResponse({
      buildId: "build-1",
      deployedSha: SHA,
      capabilityRoutesEnabled: false,
    }));

    await expect(verifyLiveRelease(validInput, fetchImpl)).resolves.toEqual({
      deployedSha: SHA,
      capabilityRoutesEnabled: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.href).toBe("https://note.syrin.online/version.json");
    expect(calls[0]?.init).toMatchObject({
      cache: "no-store",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache, no-store",
        Pragma: "no-cache",
      },
    });
  });

  it("accepts an explicitly enabled capability state", async () => {
    const { fetchImpl } = recordingFetch(manifestResponse({
      deployedSha: SHA,
      capabilityRoutesEnabled: true,
    }));

    await expect(verifyLiveRelease({
      ...validInput,
      expectedCapabilityRoutesEnabled: "true",
    }, fetchImpl)).resolves.toEqual({
      deployedSha: SHA,
      capabilityRoutesEnabled: true,
    });
  });

  it.each([
    [{ expectedSha: "" }, /40-character lowercase/],
    [{ expectedSha: SHA.toUpperCase() }, /40-character lowercase/],
    [{ expectedSha: "abc" }, /40-character lowercase/],
    [{ expectedCapabilityRoutesEnabled: "0" }, /exactly true or false/],
    [{ expectedCapabilityRoutesEnabled: "False" }, /exactly true or false/],
    [{ baseUrl: "ftp://note.syrin.online" }, /absolute HTTP or HTTPS/],
  ])("rejects invalid expected input before fetch: %o", async (override, message) => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      throw new Error("must not fetch");
    };

    await expect(
      verifyLiveRelease({ ...validInput, ...override }, fetchImpl),
    ).rejects.toThrow(message);
    expect(calls).toBe(0);
  });

  it("rejects network failures with a generic error", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("provider URL with private details");
    };
    await expect(verifyLiveRelease(validInput, fetchImpl)).rejects.toThrow(
      "Unable to fetch live release manifest.",
    );
  });

  it("requires HTTP 200 without echoing the response body", async () => {
    const secret = "body-must-not-be-logged";
    const { fetchImpl } = recordingFetch(new Response(secret, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    }));
    const message = await rejectionMessage(
      verifyLiveRelease(validInput, fetchImpl),
    );
    expect(message).toBe("Live release manifest returned HTTP 503.");
    expect(message).not.toContain(secret);
  });

  it("requires the no-store cache directive", async () => {
    const { fetchImpl } = recordingFetch(manifestResponse({
      deployedSha: SHA,
      capabilityRoutesEnabled: false,
    }, { headers: { "Cache-Control": "no-cache" } }));
    await expect(verifyLiveRelease(validInput, fetchImpl)).rejects.toThrow(
      /must use Cache-Control: no-store/,
    );
  });

  it.each([
    "x=\"foo,no-store,bar\"",
    "x=\"foo\\\",no-store,bar\"",
    "no-store, x=\"unterminated",
  ])("rejects no-store hidden by malformed or quoted directives: %s", async (
    cacheControl,
  ) => {
    const { fetchImpl } = recordingFetch(manifestResponse({
      deployedSha: SHA,
      capabilityRoutesEnabled: false,
    }, { headers: { "Cache-Control": cacheControl } }));
    await expect(verifyLiveRelease(validInput, fetchImpl)).rejects.toThrow(
      /must use Cache-Control: no-store/,
    );
  });

  it("accepts no-store outside a quoted directive", async () => {
    const { fetchImpl } = recordingFetch(manifestResponse({
      deployedSha: SHA,
      capabilityRoutesEnabled: false,
    }, { headers: { "Cache-Control": "x=\"foo,bar\", No-Store" } }));
    await expect(verifyLiveRelease(validInput, fetchImpl)).resolves.toEqual({
      deployedSha: SHA,
      capabilityRoutesEnabled: false,
    });
  });

  it.each([null, [], "\"text\"", 42])(
    "rejects a non-object manifest: %o",
    async (body) => {
      const { fetchImpl } = recordingFetch(manifestResponse(body));
      await expect(verifyLiveRelease(validInput, fetchImpl)).rejects.toThrow(
        "Live release manifest must be a JSON object.",
      );
    },
  );

  it("rejects malformed JSON", async () => {
    const { fetchImpl } = recordingFetch(manifestResponse("{"));
    await expect(verifyLiveRelease(validInput, fetchImpl)).rejects.toThrow(
      "Live release manifest is not valid JSON.",
    );
  });

  it.each([
    [{ capabilityRoutesEnabled: false }, /SHA does not match/],
    [{ deployedSha: null, capabilityRoutesEnabled: false }, /SHA does not match/],
    [{ deployedSha: OTHER_SHA, capabilityRoutesEnabled: false }, /SHA does not match/],
    [{ deployedSha: SHA }, /capability route state does not match/],
    [{ deployedSha: SHA, capabilityRoutesEnabled: null }, /capability route state does not match/],
    [{ deployedSha: SHA, capabilityRoutesEnabled: "false" }, /capability route state does not match/],
    [{ deployedSha: SHA, capabilityRoutesEnabled: true }, /capability route state does not match/],
  ])("rejects stale or malformed fields: %o", async (body, message) => {
    const { fetchImpl } = recordingFetch(manifestResponse(body));
    await expect(verifyLiveRelease(validInput, fetchImpl)).rejects.toThrow(message);
  });
});

describe("wait for live release after origin deploy", () => {
  function sequentialFetch(responses: Response[]): {
    fetchImpl: FetchLike;
    calls: number;
  } {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      fetchImpl: async () => {
        const response = responses[Math.min(calls, responses.length - 1)];
        calls += 1;
        if (!response) throw new Error("must not fetch");
        return response.clone();
      },
    };
  }

  it("returns immediately when the live SHA already matches", async () => {
    const { fetchImpl, calls } = recordingFetch(manifestResponse({
      deployedSha: SHA,
      capabilityRoutesEnabled: false,
    }));
    let slept = 0;

    await expect(waitForLiveRelease(validInput, {
      timeoutMs: 60_000,
      pollMs: 15_000,
      sleep: async (ms) => {
        slept += ms;
      },
    }, fetchImpl)).resolves.toEqual({
      deployedSha: SHA,
      capabilityRoutesEnabled: false,
    });
    expect(calls).toHaveLength(1);
    expect(slept).toBe(0);
  });

  it("retries SHA mismatch until origin ships the expected commit", async () => {
    const sequence = sequentialFetch([
      manifestResponse({
        deployedSha: OTHER_SHA,
        capabilityRoutesEnabled: false,
      }),
      manifestResponse({
        deployedSha: SHA,
        capabilityRoutesEnabled: false,
      }),
    ]);
    let now = 0;
    const slept: number[] = [];

    await expect(waitForLiveRelease(validInput, {
      timeoutMs: 60_000,
      pollMs: 15_000,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    }, sequence.fetchImpl)).resolves.toEqual({
      deployedSha: SHA,
      capabilityRoutesEnabled: false,
    });
    expect(sequence.calls).toBe(2);
    expect(slept).toEqual([15_000]);
  });

  it("does not retry a capability mismatch from an already-shipped SHA", async () => {
    const sequence = sequentialFetch([
      manifestResponse({
        deployedSha: SHA,
        capabilityRoutesEnabled: true,
      }),
      manifestResponse({
        deployedSha: SHA,
        capabilityRoutesEnabled: false,
      }),
    ]);
    let slept = 0;

    await expect(waitForLiveRelease(validInput, {
      timeoutMs: 60_000,
      pollMs: 15_000,
      sleep: async (ms) => {
        slept += ms;
      },
    }, sequence.fetchImpl)).rejects.toThrow(/capability route state does not match/);
    expect(sequence.calls).toBe(1);
    expect(slept).toBe(0);
  });

  it("stops retrying SHA mismatch after the wait deadline", async () => {
    const sequence = sequentialFetch([
      manifestResponse({
        deployedSha: OTHER_SHA,
        capabilityRoutesEnabled: false,
      }),
    ]);
    let now = 0;
    const slept: number[] = [];

    await expect(waitForLiveRelease(validInput, {
      timeoutMs: 30_000,
      pollMs: 15_000,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    }, sequence.fetchImpl)).rejects.toThrow(/SHA does not match/);
    expect(sequence.calls).toBe(3);
    expect(slept).toEqual([15_000, 15_000]);
  });

  it("retries transient fetch failures until origin is reachable", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      if (calls === 1) throw new Error("provider URL with private details");
      return manifestResponse({
        deployedSha: SHA,
        capabilityRoutesEnabled: false,
      });
    };
    let now = 0;
    const slept: number[] = [];

    await expect(waitForLiveRelease(validInput, {
      timeoutMs: 60_000,
      pollMs: 15_000,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    }, fetchImpl)).resolves.toEqual({
      deployedSha: SHA,
      capabilityRoutesEnabled: false,
    });
    expect(calls).toBe(2);
    expect(slept).toEqual([15_000]);
  });

  it("retries HTTP 5xx until the live manifest returns 200", async () => {
    const sequence = sequentialFetch([
      new Response("unavailable", {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      }),
      manifestResponse({
        deployedSha: SHA,
        capabilityRoutesEnabled: false,
      }),
    ]);
    let now = 0;
    const slept: number[] = [];

    await expect(waitForLiveRelease(validInput, {
      timeoutMs: 60_000,
      pollMs: 15_000,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    }, sequence.fetchImpl)).resolves.toEqual({
      deployedSha: SHA,
      capabilityRoutesEnabled: false,
    });
    expect(sequence.calls).toBe(2);
    expect(slept).toEqual([15_000]);
  });
});

function parseQuotedPushPathPatterns(workflow: string): string[] {
  const pushBlock =
    workflow.match(
      /\n  push:\n    branches: \[main\]\n    paths:\n([\s\S]*?)\n  workflow_dispatch:/,
    )?.[1] ?? "";
  return [...pushBlock.matchAll(/^[ \t]*- "(.+)"$/gm)].map((match) => match[1]!);
}

describe("post-deploy workflow wiring", () => {
  const workflow = readFileSync(
    resolve(".github/workflows/pwa-update-smoke-post-deploy.yml"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const pushPathPatterns = parseQuotedPushPathPatterns(workflow);

  it("requires the expected deployed SHA for manual runs", () => {
    expect(workflow).toMatch(
      / {6}expected_sha:\n {8}description: Exact deployed commit SHA expected in \/version\.json\n {8}required: true\n {8}type: string/,
    );
  });

  it("requires the expected capability route state for manual runs", () => {
    expect(workflow).toMatch(
      / {6}expected_capability_routes_enabled:\n {8}description: Expected capability route state in \/version\.json\n {8}required: true\n {8}type: choice\n {8}default: "true"\n {8}options:\n {10}- "false"\n {10}- "true"/,
    );
  });

  it("starts automatically on SPA-affecting main pushes without a GitHub deployment", () => {
    expect(workflow).toMatch(/^on:\n  deployment_status:\n  push:\n    branches: \[main\]\n    paths:\n/m);
    expect(workflow).toContain('- "src/**"');
    expect(workflow).toContain('- "!src/**/__tests__/**"');
    expect(workflow).toContain('- "!src/**/*.test.*"');
    expect(workflow).toContain('- "!src/**/*.spec.*"');
    expect(workflow).toContain('- "public/**"');
    expect(workflow).toContain('- "index.html"');
    expect(workflow).toContain('- "package.json"');
    expect(workflow).toContain('- "bun.lock"');
    expect(workflow).toContain('- "vite.config.ts"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("workflow_run:");
    expect(workflow).not.toMatch(/\n {4}paths-ignore:/);

    const pushBlock = workflow.match(/\n  push:\n    branches: \[main\]\n    paths:\n([\s\S]*?)\n  workflow_dispatch:/)?.[1] ?? "";
    expect(pushBlock).toContain('- "src/**"');
    expect(pushBlock).toMatch(
      /^ {6}- "src\/\*\*"\n {6}- "!src\/\*\*\/__tests__\/\*\*"\n {6}- "!src\/\*\*\/\*\.test\.\*"\n {6}- "!src\/\*\*\/\*\.spec\.\*"\n {6}- "!src\/integrations\/supabase\/types\.ts"$/m,
    );
    expect(pushBlock).not.toContain("docs/");
    expect(pushBlock).not.toContain("README");
    expect(pushBlock).not.toContain("canonical-origin-contract");
    expect(pushBlock).not.toContain(".github/workflows");
    expect(pushBlock).not.toContain("cloudflare-worker");
    expect(pushPathPatterns[0]).toBe("src/**");
    expect(pushPathPatterns.slice(1, 5)).toEqual([
      "!src/**/__tests__/**",
      "!src/**/*.test.*",
      "!src/**/*.spec.*",
      "!src/integrations/supabase/types.ts",
    ]);
    expect(workflow).toMatch(
      /generated from SQL|not Pages-shipped|not a Pages-shipped/i,
    );
  });

  it("does not start PWA smoke for test-only src merges", () => {
    expect(pushPathPatterns).toContain("src/**");
    expect(
      githubPathsFilterMatches(pushPathPatterns, [
        "src/lib/legacy/__tests__/migration-contract.test.ts",
      ]),
    ).toBe(false);
    expect(
      githubPathsFilterMatches(pushPathPatterns, [
        "docs/cutover.md",
        "src/lib/legacy/__tests__/migration-contract.test.ts",
      ]),
    ).toBe(false);
    expect(
      githubPathsFilterMatches(pushPathPatterns, [
        "src/pages/SharePage.privacy.test.ts",
      ]),
    ).toBe(false);
    expect(
      githubPathsFilterMatches(pushPathPatterns, [
        "src/pages/NotePage.spec.ts",
      ]),
    ).toBe(false);
  });

  it("does not start PWA smoke for SQL + docs + script tests + generated types", () => {
    const sqlDocsTypesOnly = [
      "docs/security/bulk-disable-secure-ops.md",
      "scripts/__tests__/bulk-disable-secure-contract.test.ts",
      "scripts/__tests__/capability-backend-contract.test.ts",
      "scripts/__tests__/capability-migration.integration.test.ts",
      "src/integrations/supabase/types.ts",
      "supabase/migrations/20260916000000_capability_note_bulk_disable_secure.sql",
    ];
    expect(
      githubPathsFilterMatches(pushPathPatterns, sqlDocsTypesOnly),
    ).toBe(false);
    expect(
      githubPathsFilterMatches(pushPathPatterns, [
        "src/integrations/supabase/types.ts",
      ]),
    ).toBe(false);
  });

  it("still starts PWA smoke when real SPA source ships", () => {
    expect(
      githubPathsFilterMatches(pushPathPatterns, [
        "src/pages/NotePage.tsx",
      ]),
    ).toBe(true);
    expect(
      githubPathsFilterMatches(pushPathPatterns, [
        "src/pages/NotePage.tsx",
        "src/lib/legacy/__tests__/migration-contract.test.ts",
      ]),
    ).toBe(true);
    expect(
      githubPathsFilterMatches(pushPathPatterns, ["public/sw.js"]),
    ).toBe(true);
    expect(
      githubPathsFilterMatches(pushPathPatterns, [
        "src/integrations/supabase/client.ts",
      ]),
    ).toBe(true);
    expect(
      githubPathsFilterMatches(pushPathPatterns, [
        "src/integrations/supabase/types.ts",
        "src/integrations/supabase/client.ts",
      ]),
    ).toBe(true);
  });

  it("gates the smoke job on the decide output instead of every push", () => {
    expect(workflow).toMatch(/^ {2}decide:\n {4}name: decide$/m);
    expect(workflow).toMatch(/^ {2}smoke:\n {4}name: pwa-update-smoke$/m);
    expect(workflow).toMatch(/^\s{4}needs: decide$/m);
    expect(workflow).toMatch(
      /if: needs\.decide\.outputs\.run_smoke == 'true'/,
    );
    expect(workflow).toContain("bun run scripts/spa-ship-globs.ts");
    expect(workflow).not.toMatch(
      /if: >-\n      github\.event_name == 'workflow_dispatch' \|\|\n      github\.event_name == 'push' \|\|\n      github\.event\.deployment_status\.state == 'success'/,
    );
  });

  it("passes the deployment identity expectations through job env", () => {
    expect(workflow).toMatch(
      / {6}EXPECTED_DEPLOYED_SHA: >-\n {8}\$\{\{\n {10}github\.event_name == 'workflow_dispatch' &&\n {10}inputs\.expected_sha \|\|\n {10}github\.event_name == 'deployment_status' &&\n {10}github\.event\.deployment\.sha \|\|\n {10}github\.sha\n {8}\}\}/,
    );
    expect(workflow).toMatch(
      / {6}EXPECTED_CAPABILITY_ROUTES_ENABLED: >-\n {8}\$\{\{\n {10}github\.event_name == 'workflow_dispatch' &&\n {10}inputs\.expected_capability_routes_enabled \|\|\n {10}'true'\n {8}\}\}/,
    );
    expect(workflow).toMatch(
      / {6}LIVE_RELEASE_WAIT_MS: >-\n {8}\$\{\{\n {10}github\.event_name == 'push' &&\n {10}'480000' \|\|\n {10}'0'\n {8}\}\}/,
    );
  });

  it("attests the live release before install and smoke checks", () => {
    expect(workflow).toMatch(
      / {6}- uses: oven-sh\/setup-bun@[0-9a-f]{40}(?:\s+#\s+\S+)?\n {8}with:\n {10}bun-version: 1\.3\.14\n {6}- name: Verify live release identity\n {8}run: bun run scripts\/verify-live-release\.ts\n/,
    );

    const attestationIndex = workflow.indexOf(
      "name: Verify live release identity",
    );
    expect(attestationIndex).toBeGreaterThan(-1);

    for (const laterStep of [
      "run: bun install --frozen-lockfile",
      "scripts/verify-frame-ancestors.sh",
      "run: bunx playwright install --with-deps chromium",
      "name: Run post-deploy smoke",
    ]) {
      expect(workflow.indexOf(laterStep)).toBeGreaterThan(attestationIndex);
    }
  });
});
