import { readFileSync } from "node:fs";

export interface MainPushEvent {
  ref?: string;
  forced?: boolean;
  created?: boolean;
  deleted?: boolean;
  commits?: Array<{ id?: string }>;
}

interface GuardOptions {
  repository: string;
  token: string;
  apiUrl?: string;
  fetcher?: typeof fetch;
}

interface AssociatedPullRequest {
  number: number;
  merged_at: string | null;
  base: { ref: string } | null;
  head: { sha: string } | null;
}

interface WorkflowRun {
  id: number;
  name: string | null;
  event: string;
  head_sha: string;
  status: string | null;
  conclusion: string | null;
  run_started_at?: string | null;
  created_at?: string;
  pull_requests: Array<{ number: number }> | null;
}

interface WorkflowJob {
  name: string;
  status: string;
  conclusion: string | null;
}

interface PaginatedResponse<T> {
  total_count: number;
  [key: string]: unknown;
  items?: T[];
}

const PAGE_SIZE = 100;
const MAX_API_RESULTS = 1_000;
const REQUIRED_WORKFLOWS = [
  { name: "CI", jobs: ["quality", "e2e-pr"] },
  { name: "Extension E2E", jobs: ["extension-e2e"] },
] as const;

function repositoryParts(repository: string): [string, string] | null {
  const parts = repository.split("/");
  return parts.length === 2 && parts.every(Boolean)
    ? [parts[0], parts[1]]
    : null;
}

function apiUrlFor(
  apiUrl: string,
  owner: string,
  repo: string,
  endpoint: string,
): string {
  return `${apiUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${endpoint}`;
}

async function getJson<T>(
  url: string,
  token: string,
  fetcher: typeof fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
      },
    });
  } catch {
    throw new Error(`GitHub API request failed: ${new URL(url).pathname}`);
  }

  if (!response.ok) {
    throw new Error(
      `GitHub API returned ${response.status}: ${new URL(url).pathname}`,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`GitHub API returned invalid JSON: ${new URL(url).pathname}`);
  }
}

async function listPaginated<T>(
  baseUrl: string,
  endpoint: string,
  key: string,
  token: string,
  fetcher: typeof fetch,
): Promise<T[]> {
  const items: T[] = [];

  for (let page = 1; page <= MAX_API_RESULTS / PAGE_SIZE; page += 1) {
    const url = new URL(`${baseUrl}${endpoint}`);
    url.searchParams.set("per_page", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));
    const response = await getJson<PaginatedResponse<T>>(
      url.toString(),
      token,
      fetcher,
    );
    const pageItems = response[key];

    if (!Array.isArray(pageItems)) {
      throw new Error(`GitHub API response missing ${key}`);
    }

    items.push(...(pageItems as T[]));
    const totalCount = Number(response.total_count);
    if (!Number.isFinite(totalCount) || items.length >= totalCount) return items;
    if (pageItems.length < PAGE_SIZE) return items;
  }

  throw new Error("GitHub API result exceeded the 1,000-item safety limit");
}

function isMergedIntoMain(
  pullRequest: AssociatedPullRequest,
): pullRequest is AssociatedPullRequest & {
  merged_at: string;
  base: { ref: string };
  head: { sha: string };
} {
  return Boolean(
    pullRequest.merged_at &&
      pullRequest.base?.ref === "main" &&
      /^[0-9a-f]{40}$/i.test(pullRequest.head?.sha ?? ""),
  );
}

function matchesPullRequest(run: WorkflowRun, pullRequestNumber: number): boolean {
  if (!run.pull_requests || run.pull_requests.length === 0) return true;
  return run.pull_requests.some(
    (pullRequest) => pullRequest.number === pullRequestNumber,
  );
}

function latestRun(runs: WorkflowRun[]): WorkflowRun | undefined {
  return [...runs].sort((left, right) => {
    const leftStarted = left.run_started_at ?? left.created_at ?? "";
    const rightStarted = right.run_started_at ?? right.created_at ?? "";
    return rightStarted.localeCompare(leftStarted) || right.id - left.id;
  })[0];
}

async function verifyPullRequestChecks(
  baseUrl: string,
  pullRequestNumber: number,
  headSha: string,
  token: string,
  fetcher: typeof fetch,
): Promise<string[]> {
  const failures: string[] = [];
  const runsEndpoint = `/actions/runs?head_sha=${encodeURIComponent(headSha)}&event=pull_request`;
  const runs = await listPaginated<WorkflowRun>(
    baseUrl,
    runsEndpoint,
    "workflow_runs",
    token,
    fetcher,
  );

  for (const requiredWorkflow of REQUIRED_WORKFLOWS) {
    const run = latestRun(
      runs.filter(
        (candidate) =>
          candidate.name === requiredWorkflow.name &&
          candidate.event === "pull_request" &&
          candidate.head_sha === headSha &&
          matchesPullRequest(candidate, pullRequestNumber),
      ),
    );

    if (!run) {
      failures.push(
        `PR #${pullRequestNumber} has no successful pull_request ${requiredWorkflow.name} run at its head SHA`,
      );
      continue;
    }

    if (run.status !== "completed" || run.conclusion !== "success") {
      failures.push(
        `PR #${pullRequestNumber} ${requiredWorkflow.name} workflow concluded ${run.conclusion ?? run.status ?? "unknown"}`,
      );
      continue;
    }

    const jobsEndpoint = `/actions/runs/${run.id}/jobs?filter=latest`;
    const jobs = await listPaginated<WorkflowJob>(
      baseUrl,
      jobsEndpoint,
      "jobs",
      token,
      fetcher,
    );

    for (const requiredJob of requiredWorkflow.jobs) {
      const job = jobs.find((candidate) => candidate.name === requiredJob);
      if (!job) {
        failures.push(`PR #${pullRequestNumber} is missing CI job ${requiredJob}`);
      } else if (job.status !== "completed" || job.conclusion !== "success") {
        failures.push(
          `PR #${pullRequestNumber} ${requiredWorkflow.name} job ${requiredJob} concluded ${job.conclusion ?? job.status ?? "unknown"}`,
        );
      }
    }
  }

  return failures;
}

export async function getMainGuardFailures(
  event: MainPushEvent,
  options: GuardOptions,
): Promise<string[]> {
  if (event.ref !== "refs/heads/main") return [];
  if (event.forced) return ["main was force-pushed"];
  if (event.created) return ["main was created directly without a reviewed PR"];
  if (event.deleted) return ["main was deleted"];

  const commits = [...new Set((event.commits ?? []).map((commit) => commit.id ?? ""))];
  if (commits.length === 0 || commits.some((sha) => !/^[0-9a-f]{40}$/i.test(sha))) {
    return ["main push did not include a complete, valid commit list"];
  }
  if (commits.length >= 2_048) {
    return ["main push reached GitHub's commit-list limit; refusing to pass the guard"];
  }

  const repoParts = repositoryParts(options.repository);
  if (!repoParts) return ["GITHUB_REPOSITORY must be in owner/repository form"];
  if (!options.token) return ["GITHUB_TOKEN is required for read-only PR/check verification"];

  const [owner, repo] = repoParts;
  const apiBase = options.apiUrl ?? "https://api.github.com";
  const baseUrl = apiUrlFor(apiBase, owner, repo, "");
  const fetcher = options.fetcher ?? fetch;
  const failures: string[] = [];
  const verifiedPullRequests = new Map<number, AssociatedPullRequest>();

  for (const commitSha of commits) {
    const endpoint = `/commits/${encodeURIComponent(commitSha)}/pulls?per_page=${PAGE_SIZE}`;
    const pullRequests = await getJson<AssociatedPullRequest[]>(
      `${baseUrl}${endpoint}`,
      options.token,
      fetcher,
    );

    if (!Array.isArray(pullRequests)) {
      throw new Error("GitHub API returned an invalid pull-request association list");
    }

    const mergedPullRequests = pullRequests.filter(isMergedIntoMain);
    if (mergedPullRequests.length === 0) {
      failures.push(
        `commit ${commitSha.slice(0, 12)} is not associated with a merged PR into main`,
      );
      continue;
    }

    for (const pullRequest of mergedPullRequests) {
      verifiedPullRequests.set(pullRequest.number, pullRequest);
    }
  }

  for (const pullRequest of verifiedPullRequests.values()) {
    failures.push(
      ...(await verifyPullRequestChecks(
        baseUrl,
        pullRequest.number,
        pullRequest.head.sha,
        options.token,
        fetcher,
      )),
    );
  }

  return failures;
}

async function runFromGitHubActions(): Promise<void> {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) throw new Error("GITHUB_EVENT_PATH is missing");
    const event = JSON.parse(readFileSync(eventPath, "utf8")) as MainPushEvent;
    const failures = await getMainGuardFailures(event, {
      repository: process.env.GITHUB_REPOSITORY ?? "",
      token: process.env.GITHUB_TOKEN ?? "",
      apiUrl: process.env.GITHUB_API_URL,
    });

    if (failures.length > 0) {
      console.error("main-guard failed:");
      for (const failure of failures) console.error(`- ${failure}`);
      process.exitCode = 1;
      return;
    }

    if (event.ref === "refs/heads/main") {
      console.log(
        `main-guard passed: ${new Set((event.commits ?? []).map((commit) => commit.id)).size} pushed commit(s) came from merged PRs with successful required checks.`,
      );
    } else {
      console.log("main-guard skipped: event does not update main.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected error";
    console.error(`main-guard failed closed: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await runFromGitHubActions();
}
