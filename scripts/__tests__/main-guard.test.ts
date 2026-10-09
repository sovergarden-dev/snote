import { describe, expect, it } from "vitest";
import { getMainGuardFailures } from "../main-guard";

const REPOSITORY = "sovergarden-dev/snote";
const COMMIT_SHA = "b".repeat(40);
const HEAD_SHA = "a".repeat(40);
const PR_NUMBER = 171;

interface FakeApiOptions {
  associatedPullRequests?: unknown[];
  workflowRuns?: unknown[];
  jobsByRunId?: Record<number, unknown[]>;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeApi(options: FakeApiOptions = {}) {
  const requests: URL[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);

    if (url.pathname.endsWith(`/commits/${COMMIT_SHA}/pulls`)) {
      return jsonResponse(options.associatedPullRequests ?? [
        {
          number: PR_NUMBER,
          merged_at: "2026-10-09T00:00:00Z",
          base: { ref: "main" },
          head: { sha: HEAD_SHA },
        },
      ]);
    }

    if (url.pathname.endsWith("/actions/runs")) {
      return jsonResponse({
        total_count: (options.workflowRuns ?? []).length,
        workflow_runs: options.workflowRuns ?? [
          {
            id: 101,
            name: "CI",
            event: "pull_request",
            head_sha: HEAD_SHA,
            status: "completed",
            conclusion: "success",
            created_at: "2026-10-09T00:01:00Z",
            pull_requests: [{ number: PR_NUMBER }],
          },
          {
            id: 102,
            name: "Extension E2E",
            event: "pull_request",
            head_sha: HEAD_SHA,
            status: "completed",
            conclusion: "success",
            created_at: "2026-10-09T00:02:00Z",
            pull_requests: [{ number: PR_NUMBER }],
          },
        ],
      });
    }

    const jobsMatch = url.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/);
    if (jobsMatch) {
      const runId = Number(jobsMatch[1]);
      const defaultJobs =
        runId === 101
          ? [
              { name: "quality", status: "completed", conclusion: "success" },
              { name: "e2e-pr", status: "completed", conclusion: "success" },
              {
                name: "e2e-full-chromium",
                status: "completed",
                conclusion: "skipped",
              },
            ]
          : [
              {
                name: "extension-e2e",
                status: "completed",
                conclusion: "success",
              },
            ];
      const jobs = options.jobsByRunId?.[runId] ?? defaultJobs;
      return jsonResponse({ total_count: jobs.length, jobs });
    }

    return new Response("unexpected API path", { status: 404 });
  };

  return { fetcher, requests };
}

function pushEvent(overrides: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main",
    forced: false,
    created: false,
    deleted: false,
    commits: [{ id: COMMIT_SHA }],
    ...overrides,
  };
}

const apiOptions = (fetcher: typeof fetch) => ({
  repository: REPOSITORY,
  token: "test-token",
  fetcher,
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

  it("rejects force-pushes to main before querying GitHub", async () => {
    const api = makeApi();

    await expect(
      getMainGuardFailures(pushEvent({ forced: true }), apiOptions(api.fetcher)),
    ).resolves.toContain("main was force-pushed");
    expect(api.requests).toHaveLength(0);
  });

  it("rejects commits with no merged PR association as direct pushes", async () => {
    const api = makeApi({ associatedPullRequests: [] });

    const failures = await getMainGuardFailures(
      pushEvent(),
      apiOptions(api.fetcher),
    );

    expect(failures).toContain(
      `commit ${COMMIT_SHA.slice(0, 12)} is not associated with a merged PR into main`,
    );
    expect(api.requests).toHaveLength(1);
  });

  it("passes only when the merged PR's pull_request checks are all successful", async () => {
    const api = makeApi();

    await expect(
      getMainGuardFailures(pushEvent(), apiOptions(api.fetcher)),
    ).resolves.toEqual([]);

    expect(api.requests.some((url) => url.searchParams.get("event") === "pull_request"))
      .toBe(true);
    expect(api.requests.some((url) => url.pathname.endsWith("/actions/runs/101/jobs")))
      .toBe(true);
    expect(api.requests.some((url) => url.pathname.endsWith("/actions/runs/102/jobs")))
      .toBe(true);
  });

  it("accepts exact head-SHA runs when GitHub omits PR associations after merge", async () => {
    const api = makeApi({
      workflowRuns: [
        {
          id: 101,
          name: "CI",
          event: "pull_request",
          head_sha: HEAD_SHA,
          status: "completed",
          conclusion: "success",
          created_at: "2026-10-09T00:01:00Z",
          pull_requests: [],
        },
        {
          id: 102,
          name: "Extension E2E",
          event: "pull_request",
          head_sha: HEAD_SHA,
          status: "completed",
          conclusion: "success",
          created_at: "2026-10-09T00:02:00Z",
          pull_requests: [],
        },
      ],
    });

    await expect(
      getMainGuardFailures(pushEvent(), apiOptions(api.fetcher)),
    ).resolves.toEqual([]);
  });

  it("fails when a required job is red even if the workflow run exists", async () => {
    const api = makeApi({
      jobsByRunId: {
        101: [
          { name: "quality", status: "completed", conclusion: "success" },
          { name: "e2e-pr", status: "completed", conclusion: "failure" },
        ],
      },
    });

    const failures = await getMainGuardFailures(
      pushEvent(),
      apiOptions(api.fetcher),
    );

    expect(failures).toContain("PR #171 CI job e2e-pr concluded failure");
  });

  it("does not accept successful runs that belong to a different PR", async () => {
    const api = makeApi({
      workflowRuns: [
        {
          id: 101,
          name: "CI",
          event: "pull_request",
          head_sha: HEAD_SHA,
          status: "completed",
          conclusion: "success",
          created_at: "2026-10-09T00:01:00Z",
          pull_requests: [{ number: 999 }],
        },
        {
          id: 102,
          name: "Extension E2E",
          event: "pull_request",
          head_sha: HEAD_SHA,
          status: "completed",
          conclusion: "success",
          created_at: "2026-10-09T00:02:00Z",
          pull_requests: [{ number: 999 }],
        },
      ],
    });

    const failures = await getMainGuardFailures(
      pushEvent(),
      apiOptions(api.fetcher),
    );

    expect(failures).toContain("PR #171 has no successful pull_request CI run at its head SHA");
    expect(failures).toContain(
      "PR #171 has no successful pull_request Extension E2E run at its head SHA",
    );
  });
});
