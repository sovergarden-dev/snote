import { describe, expect, it } from "vitest";
import {
  getMainGuardFailures,
  reportMainGuardFailure,
} from "../main-guard";

const REPOSITORY = "sovergarden-dev/snote";
const BASE_SHA = "6a3a3b40d7db12057d761d7260fa712d96049548";
const COMMIT_SHA = "b".repeat(40);
const PREVIOUS_SHA = "d".repeat(40);
const HEAD_SHA = "a".repeat(40);
const PREVIOUS_HEAD_SHA = "e".repeat(40);
const PR_NUMBER = 172;
const VERSION_URL = "https://note.syrin.online/version.json";

interface FakeApiOptions {
  associatedPullRequestsByCommit?: Record<string, unknown[]>;
  parents?: Record<string, string | null>;
  mainSha?: string;
  workflowRunsByEvent?: Record<string, unknown[]>;
  jobsByRunId?: Record<number, unknown[]>;
  deployedSha?: unknown;
  compareStatus?: string;
  compareMergeBaseSha?: string;
  openIssues?: unknown[];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pullRequest(
  number: number,
  mergeCommitSha: string,
  headSha: string,
): Record<string, unknown> {
  return {
    number,
    merged_at: "2026-10-09T00:00:00Z",
    merge_commit_sha: mergeCommitSha,
    base: { ref: "main" },
    head: { sha: headSha },
  };
}

function successfulRuns(headSha = HEAD_SHA, pullRequestNumber = PR_NUMBER) {
  return {
    pull_request: [
      {
        id: 101,
        name: "CI",
        event: "pull_request",
        head_sha: headSha,
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-10-09T00:01:00Z",
        pull_requests: [{ number: pullRequestNumber }],
      },
      {
        id: 102,
        name: "Extension E2E",
        event: "pull_request",
        head_sha: headSha,
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-10-09T00:02:00Z",
        pull_requests: [{ number: pullRequestNumber }],
      },
    ],
    workflow_dispatch: [
      {
        id: 103,
        name: "CI",
        event: "workflow_dispatch",
        head_sha: headSha,
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-10-09T00:03:00Z",
        pull_requests: [],
      },
    ],
  };
}

function makeApi(options: FakeApiOptions = {}) {
  const requests: Array<{ url: URL; method: string; body?: unknown }> = [];
  const defaultRuns = successfulRuns();
  const createdIssues: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    requests.push({ url, method, body });

    if (url.origin === "https://note.syrin.online" && url.pathname === "/version.json") {
      return jsonResponse({ deployedSha: options.deployedSha ?? BASE_SHA });
    }

    if (url.pathname.includes("/compare/")) {
      const range = url.pathname.split("/compare/")[1] ?? "";
      const [baseSha] = range.split("...");
      return jsonResponse({
        status: options.compareStatus ?? "ahead",
        base_commit: { sha: baseSha },
        merge_base_commit: {
          sha: options.compareMergeBaseSha ?? options.deployedSha ?? BASE_SHA,
        },
      });
    }

    if (url.pathname.endsWith("/commits/main")) {
      return jsonResponse({ sha: options.mainSha ?? COMMIT_SHA });
    }

    const associatedMatch = url.pathname.match(/\/commits\/([0-9a-f]{40})\/pulls$/i);
    if (associatedMatch) {
      const sha = associatedMatch[1];
      return jsonResponse(
        options.associatedPullRequestsByCommit?.[sha] ?? [
          pullRequest(PR_NUMBER, sha, HEAD_SHA),
        ],
      );
    }

    const commitMatch = url.pathname.match(/\/commits\/([0-9a-f]{40})$/i);
    if (commitMatch) {
      const sha = commitMatch[1];
      const parent = options.parents?.[sha] ?? (sha === COMMIT_SHA ? BASE_SHA : null);
      return jsonResponse({
        sha,
        parents: parent ? [{ sha: parent }] : [],
      });
    }

    if (url.pathname.endsWith("/actions/runs")) {
      const event = url.searchParams.get("event") ?? "";
      const runs = options.workflowRunsByEvent?.[event] ??
        defaultRuns[event as keyof typeof defaultRuns] ?? [];
      return jsonResponse({ total_count: runs.length, workflow_runs: runs });
    }

    const jobsMatch = url.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/);
    if (jobsMatch) {
      const runId = Number(jobsMatch[1]);
      const defaults: Record<number, unknown[]> = {
        101: [
          { name: "quality", status: "completed", conclusion: "success" },
          { name: "e2e-pr", status: "completed", conclusion: "success" },
        ],
        102: [
          { name: "extension-e2e", status: "completed", conclusion: "success" },
        ],
        103: [
          { name: "e2e-full-chromium", status: "completed", conclusion: "success" },
          { name: "e2e-full-firefox", status: "completed", conclusion: "success" },
          { name: "e2e-full-webkit", status: "completed", conclusion: "success" },
        ],
      };
      const jobs = options.jobsByRunId?.[runId] ?? defaults[runId] ?? [];
      return jsonResponse({ total_count: jobs.length, jobs });
    }

    if (url.pathname.endsWith("/issues") && method === "GET") {
      return jsonResponse(options.openIssues ?? []);
    }

    if (url.pathname.endsWith("/issues") && method === "POST") {
      createdIssues.push(body);
      return jsonResponse({ number: 300, ...(body as object) }, 201);
    }

    return new Response(`unexpected API path: ${url.pathname}`, { status: 404 });
  };

  return { fetcher, requests, createdIssues };
}

function pushEvent(overrides: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main",
    forced: false,
    created: false,
    deleted: false,
    before: BASE_SHA,
    after: COMMIT_SHA,
    ...overrides,
  };
}

const apiOptions = (fetcher: typeof fetch, overrides: Record<string, unknown> = {}) => ({
  repository: REPOSITORY,
  token: "test-token",
  apiUrl: "https://api.github.test",
  versionUrl: VERSION_URL,
  fetcher,
  ...overrides,
});

describe("main-guard", () => {
  it("ignores events that do not update main without making API calls", async () => {
    const api = makeApi();

    await expect(
      getMainGuardFailures(
        pushEvent({ ref: "refs/heads/chore/example" }),
        apiOptions(api.fetcher),
      ),
    ).resolves.toEqual([]);
    expect(api.requests).toHaveLength(0);
  });

  it("rejects force-pushes, direct branch creation, and deletion before querying GitHub", async () => {
    for (const [override, message] of [
      [{ forced: true }, "main was force-pushed"],
      [{ created: true }, "main was created directly without a reviewed PR"],
      [{ deleted: true }, "main was deleted"],
    ] as const) {
      const api = makeApi();
      await expect(
        getMainGuardFailures(pushEvent(override), apiOptions(api.fetcher)),
      ).resolves.toContain(message);
      expect(api.requests).toHaveLength(0);
    }
  });

  it("walks every first-parent commit after the fixed baseline, not the webhook commit array", async () => {
    const api = makeApi({
      parents: { [COMMIT_SHA]: PREVIOUS_SHA, [PREVIOUS_SHA]: BASE_SHA },
      associatedPullRequestsByCommit: {
        [COMMIT_SHA]: [pullRequest(172, COMMIT_SHA, HEAD_SHA)],
        [PREVIOUS_SHA]: [],
      },
    });

    const failures = await getMainGuardFailures(
      pushEvent({ commits: [] }),
      apiOptions(api.fetcher),
    );

    expect(failures).toContain(
      `commit ${PREVIOUS_SHA.slice(0, 12)} is not associated with a merged PR into main`,
    );
    expect(
      api.requests.some((request) => request.url.pathname.endsWith(`/commits/${PREVIOUS_SHA}`)),
    ).toBe(true);
    expect(
      api.requests.some((request) => request.url.pathname.endsWith(`/commits/${PREVIOUS_SHA}/pulls`)),
    ).toBe(true);
  });

  it("fails closed when the baseline is not reached within 30 first-parent commits", async () => {
    const parentMap: Record<string, string | null> = {};
    let parent = "f".repeat(40);
    const head = parent;
    for (let index = 0; index < 30; index += 1) {
      const next = (index + 1).toString(16).padStart(40, "0");
      parentMap[parent] = next;
      parent = next;
    }
    parentMap[parent] = "9".repeat(40);
    const api = makeApi({ mainSha: head, parents: parentMap });

    const failures = await getMainGuardFailures(
      pushEvent({ after: undefined }),
      apiOptions(api.fetcher, { eventName: "schedule" }),
    );

    expect(failures).toContain(
      "main first-parent history did not reach baseline 6a3a3b40d7db12057d761d7260fa712d96049548 within 30 commits",
    );
    expect(api.requests.filter((request) => /\/commits\/[0-9a-f]{40}$/.test(request.url.pathname)))
      .toHaveLength(30);
  });

  it("requires each main commit to equal the associated PR merge_commit_sha", async () => {
    const api = makeApi({
      associatedPullRequestsByCommit: {
        [COMMIT_SHA]: [pullRequest(PR_NUMBER, PREVIOUS_SHA, HEAD_SHA)],
      },
    });

    const failures = await getMainGuardFailures(pushEvent(), apiOptions(api.fetcher));

    expect(failures).toContain(
      `commit ${COMMIT_SHA.slice(0, 12)} does not equal PR #${PR_NUMBER} merge_commit_sha`,
    );
  });

  it("passes only when PR checks and workflow_dispatch full browser e2e are green at PR head", async () => {
    const api = makeApi();

    await expect(
      getMainGuardFailures(pushEvent(), apiOptions(api.fetcher)),
    ).resolves.toEqual([]);

    expect(api.requests.some((request) => request.url.searchParams.get("event") === "pull_request"))
      .toBe(true);
    expect(api.requests.some((request) => request.url.searchParams.get("event") === "workflow_dispatch"))
      .toBe(true);
    expect(api.requests.some((request) => request.url.pathname.endsWith("/actions/runs/101/jobs")))
      .toBe(true);
    expect(api.requests.some((request) => request.url.pathname.endsWith("/actions/runs/102/jobs")))
      .toBe(true);
    expect(api.requests.some((request) => request.url.pathname.endsWith("/actions/runs/103/jobs")))
      .toBe(true);
  });

  it("fails if the workflow_dispatch e2e-full run is absent or belongs to a different head SHA", async () => {
    const api = makeApi({
      workflowRunsByEvent: {
        workflow_dispatch: [
          {
            id: 103,
            name: "CI",
            event: "workflow_dispatch",
            head_sha: PREVIOUS_HEAD_SHA,
            status: "completed",
            conclusion: "success",
            pull_requests: [],
          },
        ],
      },
    });

    const failures = await getMainGuardFailures(pushEvent(), apiOptions(api.fetcher));

    expect(failures).toContain(
      `PR #${PR_NUMBER} has no successful workflow_dispatch CI run at its head SHA`,
    );
  });

  it("fails when any required full-browser job is red", async () => {
    const api = makeApi({
      jobsByRunId: {
        103: [
          { name: "e2e-full-chromium", status: "completed", conclusion: "success" },
          { name: "e2e-full-firefox", status: "completed", conclusion: "failure" },
          { name: "e2e-full-webkit", status: "completed", conclusion: "success" },
        ],
      },
    });

    const failures = await getMainGuardFailures(pushEvent(), apiOptions(api.fetcher));

    expect(failures).toContain(
      `PR #${PR_NUMBER} CI job e2e-full-firefox concluded failure`,
    );
  });

  it("checks deployedSha from version.json against the main history", async () => {
    const api = makeApi({
      deployedSha: PREVIOUS_SHA,
      compareStatus: "diverged",
      compareMergeBaseSha: "9".repeat(40),
    });

    const failures = await getMainGuardFailures(pushEvent(), apiOptions(api.fetcher));

    expect(failures).toContain(
      `deployedSha ${PREVIOUS_SHA.slice(0, 12)} from version.json is not an ancestor of main`,
    );
    expect(api.requests.some((request) => request.url.href === VERSION_URL)).toBe(true);
  });

  it("uses the current main ref on the weekly schedule when no push after-SHA exists", async () => {
    const api = makeApi();

    await expect(
      getMainGuardFailures(
        pushEvent({ after: undefined }),
        apiOptions(api.fetcher, { eventName: "schedule" }),
      ),
    ).resolves.toEqual([]);
    expect(api.requests.some((request) => request.url.pathname.endsWith("/commits/main")))
      .toBe(true);
  });

  it("opens one issue assigned to the repository owner when no open guard issue exists", async () => {
    const api = makeApi();

    const issue = await reportMainGuardFailure(["main commit was rejected"], {
      ...apiOptions(api.fetcher),
      mainSha: COMMIT_SHA,
      eventName: "push",
      actor: "sovergarden-dev",
      runUrl: "https://github.com/sovergarden-dev/snote/actions/runs/42",
    });

    expect(issue).toEqual({ number: 300, created: true });
    expect(api.createdIssues).toHaveLength(1);
    expect(api.createdIssues[0]).toMatchObject({
      title: "[main-guard] Main policy violations",
      assignees: ["sovergarden-dev"],
    });
    expect((api.createdIssues[0] as { body: string }).body).toContain("@sovergarden-dev");
    expect((api.createdIssues[0] as { body: string }).body).toContain("main commit was rejected");
  });

  it("reuses an existing open guard issue instead of creating duplicates", async () => {
    const api = makeApi({
      openIssues: [
        {
          number: 299,
          title: "[main-guard] Main policy violations",
          state: "open",
        },
      ],
    });

    const issue = await reportMainGuardFailure(["another failure"], {
      ...apiOptions(api.fetcher),
      mainSha: COMMIT_SHA,
      eventName: "schedule",
      actor: "sovergarden-dev",
      runUrl: "https://github.com/sovergarden-dev/snote/actions/runs/43",
    });

    expect(issue).toEqual({ number: 299, created: false });
    expect(api.createdIssues).toHaveLength(0);
  });
});
