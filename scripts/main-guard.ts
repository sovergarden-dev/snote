import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface MainPushEvent {
  ref?: string;
  before?: string;
  forced?: boolean;
  created?: boolean;
  deleted?: boolean;
  after?: string;
}

interface GuardOptions {
  repository: string;
  token: string;
  apiUrl?: string;
  versionUrl?: string;
  eventName?: string;
  currentMainSha?: string;
  fetcher?: typeof fetch;
}

interface FailureIssueOptions extends GuardOptions {
  mainSha: string;
  before?: string;
  actor?: string;
  runUrl?: string;
}

interface AssociatedPullRequest {
  number: number;
  merged_at: string | null;
  merge_commit_sha?: string | null;
  base: { ref: string } | null;
  head: { sha: string } | null;
}

interface GitHubCommit {
  sha: string;
  parents?: Array<{ sha: string }>;
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

interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  body?: string | null;
  pull_request?: unknown;
}

interface GitHubIssueComment {
  body?: string | null;
}

interface CompareResponse {
  status: string;
  base_commit?: { sha: string };
  merge_base_commit?: { sha: string };
}

interface LiveVersion {
  deployedSha?: unknown;
}

const PAGE_SIZE = 100;
const MAX_API_RESULTS = 1_000;
const MAX_FIRST_PARENT_COMMITS = 30;
const GITHUB_API_VERSION = "2022-11-28";
const MAIN_GUARD_BASE_SHA = "6a3a3b404b719473af14a798a644f47af0ed3904";
const MAIN_GUARD_ISSUE_TITLE = "[main-guard] Main policy violations";
const DEFAULT_VERSION_URL = "https://note.syrin.online/version.json";
const REQUIRED_WORKFLOWS = [
  { name: "CI", event: "pull_request", jobs: ["quality", "e2e-pr"] },
  { name: "Extension E2E", event: "pull_request", jobs: ["extension-e2e"] },
  {
    name: "CI",
    event: "workflow_dispatch",
    jobs: ["e2e-full-chromium", "e2e-full-firefox", "e2e-full-webkit"],
  },
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

async function requestJson<T>(
  url: string,
  fetcher: typeof fetch,
  options: { token?: string; method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
    headers["X-GitHub-Api-Version"] = GITHUB_API_VERSION;
  }
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetcher(url, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
  } catch {
    throw new Error(`HTTP request failed: ${new URL(url).pathname}`);
  }

  if (!response.ok) {
    throw new Error(
      `HTTP request returned ${response.status}: ${new URL(url).pathname}`,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`HTTP request returned invalid JSON: ${new URL(url).pathname}`);
  }
}

async function getJson<T>(
  url: string,
  token: string,
  fetcher: typeof fetch,
): Promise<T> {
  return requestJson<T>(url, fetcher, { token });
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

async function verifyWorkflowJobs(
  baseUrl: string,
  pullRequestNumber: number,
  headSha: string,
  requiredWorkflow: (typeof REQUIRED_WORKFLOWS)[number],
  token: string,
  fetcher: typeof fetch,
): Promise<string[]> {
  const failures: string[] = [];
  const runsEndpoint = `/actions/runs?head_sha=${encodeURIComponent(headSha)}&event=${requiredWorkflow.event}`;
  const runs = await listPaginated<WorkflowRun>(
    baseUrl,
    runsEndpoint,
    "workflow_runs",
    token,
    fetcher,
  );
  const run = latestRun(
    runs.filter(
      (candidate) =>
        candidate.name === requiredWorkflow.name &&
        candidate.event === requiredWorkflow.event &&
        candidate.head_sha === headSha &&
        matchesPullRequest(candidate, pullRequestNumber),
    ),
  );

  if (!run) {
    failures.push(
      `PR #${pullRequestNumber} has no successful ${requiredWorkflow.event} ${requiredWorkflow.name} run at its head SHA`,
    );
    return failures;
  }

  if (run.status !== "completed" || run.conclusion !== "success") {
    failures.push(
      `PR #${pullRequestNumber} ${requiredWorkflow.name} (${requiredWorkflow.event}) workflow concluded ${run.conclusion ?? run.status ?? "unknown"}`,
    );
    return failures;
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
        `PR #${pullRequestNumber} CI job ${requiredJob} concluded ${job.conclusion ?? job.status ?? "unknown"}`,
      );
    }
  }

  return failures;
}

async function getMainHeadSha(
  event: MainPushEvent,
  options: GuardOptions,
  baseUrl: string,
  token: string,
  fetcher: typeof fetch,
): Promise<string> {
  if ((options.eventName ?? "push") === "schedule") {
    const response = await getJson<{ sha?: string }>(
      `${baseUrl}/commits/main`,
      token,
      fetcher,
    );
    if (!/^[0-9a-f]{40}$/i.test(response.sha ?? "")) {
      throw new Error("GitHub API did not return a valid current main SHA");
    }
    return response.sha!;
  }

  if (!/^[0-9a-f]{40}$/i.test(event.after ?? "")) {
    throw new Error("main push did not include a valid after SHA");
  }
  return event.after!;
}

async function getFirstParentCommits(
  mainSha: string,
  baseUrl: string,
  token: string,
  fetcher: typeof fetch,
): Promise<{ commits: string[]; reachedBaseline: boolean }> {
  const commits: string[] = [];
  let currentSha = mainSha;

  while (
    currentSha !== MAIN_GUARD_BASE_SHA &&
    commits.length < MAX_FIRST_PARENT_COMMITS
  ) {
    const commit = await getJson<GitHubCommit>(
      `${baseUrl}/commits/${encodeURIComponent(currentSha)}`,
      token,
      fetcher,
    );
    if (commit.sha !== currentSha) {
      throw new Error("GitHub API returned a commit with a mismatched SHA");
    }
    const firstParent = commit.parents?.[0]?.sha;
    if (!/^[0-9a-f]{40}$/i.test(firstParent ?? "")) {
      throw new Error(
        `main first-parent history ended before baseline ${MAIN_GUARD_BASE_SHA}`,
      );
    }
    commits.push(currentSha);
    currentSha = firstParent!;
  }

  return { commits, reachedBaseline: currentSha === MAIN_GUARD_BASE_SHA };
}

async function verifyDeployedVersion(
  mainSha: string,
  baseUrl: string,
  options: GuardOptions,
  token: string,
  fetcher: typeof fetch,
): Promise<string[]> {
  const versionUrl = options.versionUrl ?? DEFAULT_VERSION_URL;
  const version = await requestJson<LiveVersion>(versionUrl, fetcher);
  const deployedSha = version.deployedSha;
  if (typeof deployedSha !== "string" || !/^[0-9a-f]{40}$/i.test(deployedSha)) {
    return ["version.json did not contain a valid deployedSha"];
  }

  const comparison = await getJson<CompareResponse>(
    `${baseUrl}/compare/${encodeURIComponent(deployedSha)}...${encodeURIComponent(mainSha)}`,
    token,
    fetcher,
  );
  const isAncestor =
    (comparison.status === "ahead" || comparison.status === "identical") &&
    comparison.base_commit?.sha === deployedSha &&
    comparison.merge_base_commit?.sha === deployedSha;

  if (!isAncestor) {
    return [
      `deployedSha ${deployedSha.slice(0, 12)} from version.json is not an ancestor of main`,
    ];
  }
  return [];
}

export async function getMainGuardFailures(
  event: MainPushEvent,
  options: GuardOptions,
): Promise<string[]> {
  const eventName = options.eventName ?? "push";
  if (event.ref !== "refs/heads/main") return [];
  if (eventName === "push") {
    if (event.forced) return ["main was force-pushed"];
    if (event.created) return ["main was created directly without a reviewed PR"];
    if (event.deleted) return ["main was deleted"];
  }

  const repoParts = repositoryParts(options.repository);
  if (!repoParts) return ["GITHUB_REPOSITORY must be in owner/repository form"];
  if (!options.token) return ["GITHUB_TOKEN is required for main-guard verification"];

  const [owner, repo] = repoParts;
  const apiBase = options.apiUrl ?? "https://api.github.com";
  const baseUrl = apiUrlFor(apiBase, owner, repo, "");
  const fetcher = options.fetcher ?? fetch;
  const failures: string[] = [];
  const mainSha = await getMainHeadSha(event, options, baseUrl, options.token, fetcher);
  const history = await getFirstParentCommits(
    mainSha,
    baseUrl,
    options.token,
    fetcher,
  );

  if (!history.reachedBaseline) {
    failures.push(
      `main first-parent history did not reach baseline ${MAIN_GUARD_BASE_SHA} within ${MAX_FIRST_PARENT_COMMITS} commits`,
    );
  }

  const verifiedPullRequests = new Map<number, AssociatedPullRequest>();
  for (const commitSha of history.commits) {
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

    const pullRequestMissingMergeCommitSha = mergedPullRequests.find(
      (pullRequest) => !pullRequest.merge_commit_sha,
    );
    if (pullRequestMissingMergeCommitSha) {
      throw new Error(
        `GitHub API response is missing merge_commit_sha for PR #${pullRequestMissingMergeCommitSha.number}`,
      );
    }

    const matchingMerge = mergedPullRequests.filter(
      (pullRequest) => pullRequest.merge_commit_sha === commitSha,
    );
    if (matchingMerge.length === 0) {
      failures.push(
        `commit ${commitSha.slice(0, 12)} does not equal PR #${mergedPullRequests[0].number} merge_commit_sha`,
      );
      continue;
    }

    for (const pullRequest of matchingMerge) {
      verifiedPullRequests.set(pullRequest.number, pullRequest);
    }
  }

  for (const pullRequest of verifiedPullRequests.values()) {
    for (const requiredWorkflow of REQUIRED_WORKFLOWS) {
      failures.push(
        ...(await verifyWorkflowJobs(
          baseUrl,
          pullRequest.number,
          pullRequest.head.sha,
          requiredWorkflow,
          options.token,
          fetcher,
        )),
      );
    }
  }

  failures.push(
    ...(await verifyDeployedVersion(
      mainSha,
      baseUrl,
      options,
      options.token,
      fetcher,
    )),
  );
  return failures;
}

async function findOpenGuardIssue(
  baseUrl: string,
  token: string,
  fetcher: typeof fetch,
): Promise<GitHubIssue | undefined> {
  for (let page = 1; page <= MAX_API_RESULTS / PAGE_SIZE; page += 1) {
    const url = new URL(`${baseUrl}/issues`);
    url.searchParams.set("state", "open");
    url.searchParams.set("per_page", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));
    const issues = await getJson<GitHubIssue[]>(url.toString(), token, fetcher);
    if (!Array.isArray(issues)) throw new Error("GitHub API returned an invalid issue list");

    const existing = issues.find(
      (issue) =>
        issue.state === "open" &&
        issue.title === MAIN_GUARD_ISSUE_TITLE &&
        !issue.pull_request,
    );
    if (existing) return existing;
    if (issues.length < PAGE_SIZE) return undefined;
  }

  throw new Error("Open issue list exceeded the 1,000-item safety limit");
}

function violationFingerprint(mainSha: string, failures: string[]): string {
  const canonicalFailures = [...new Set(failures)].sort();
  return createHash("sha256")
    .update(JSON.stringify({ mainSha, failures: canonicalFailures }))
    .digest("hex");
}

function fingerprintMarker(fingerprint: string): string {
  return `<!-- main-guard-fingerprint:${fingerprint} -->`;
}

function buildFailureBody(
  owner: string,
  failures: string[],
  options: FailureIssueOptions,
  fingerprint: string,
): string {
  const canonicalFailures = [...new Set(failures)].sort();
  const visibleFailures = canonicalFailures.slice(0, 100);
  const omittedCount = canonicalFailures.length - visibleFailures.length;
  const runLink = options.runUrl ?? "Unavailable in this run context";
  return [
    fingerprintMarker(fingerprint),
    `@${owner} main-guard found policy violations on \`${options.mainSha}\`.`,
    "",
    `- Event: \`${options.eventName ?? "unknown"}\``,
    `- event.before: \`${options.before ?? "not supplied by event"}\``,
    `- Actor: \`${options.actor ?? "unknown"}\``,
    `- Workflow run: ${runLink}`,
    "",
    "### Findings",
    ...visibleFailures.map((failure) => `- ${failure}`),
    ...(omittedCount > 0 ? [`- ${omittedCount} additional finding(s) omitted.`] : []),
  ].join("\n");
}

async function listIssueComments(
  baseUrl: string,
  issueNumber: number,
  token: string,
  fetcher: typeof fetch,
): Promise<GitHubIssueComment[]> {
  const comments: GitHubIssueComment[] = [];
  for (let page = 1; page <= MAX_API_RESULTS / PAGE_SIZE; page += 1) {
    const url = new URL(`${baseUrl}/issues/${encodeURIComponent(String(issueNumber))}/comments`);
    url.searchParams.set("per_page", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));
    const pageComments = await getJson<GitHubIssueComment[]>(url.toString(), token, fetcher);
    if (!Array.isArray(pageComments)) {
      throw new Error("GitHub API returned an invalid issue comment list");
    }
    comments.push(...pageComments);
    if (pageComments.length < PAGE_SIZE) return comments;
  }
  throw new Error("Issue comment list exceeded the 1,000-item safety limit");
}

export async function reportMainGuardFailure(
  failures: string[],
  options: FailureIssueOptions,
): Promise<{ number: number; created: boolean; action: "created" | "commented" | "duplicate" }> {
  const repoParts = repositoryParts(options.repository);
  if (!repoParts) throw new Error("GITHUB_REPOSITORY must be in owner/repository form");
  if (!options.token) throw new Error("GITHUB_TOKEN is required to report main-guard failures");
  if (failures.length === 0) throw new Error("Cannot report an empty main-guard failure");

  const [owner, repo] = repoParts;
  const baseUrl = apiUrlFor(options.apiUrl ?? "https://api.github.com", owner, repo, "");
  const fetcher = options.fetcher ?? fetch;
  const fingerprint = violationFingerprint(options.mainSha, failures);
  const marker = fingerprintMarker(fingerprint);
  const body = buildFailureBody(owner, failures, options, fingerprint);
  const existing = await findOpenGuardIssue(baseUrl, options.token, fetcher);

  if (existing) {
    if (existing.body?.includes(marker)) {
      return { number: existing.number, created: false, action: "duplicate" };
    }
    const comments = await listIssueComments(baseUrl, existing.number, options.token, fetcher);
    if (comments.some((comment) => comment.body?.includes(marker))) {
      return { number: existing.number, created: false, action: "duplicate" };
    }
    await requestJson<GitHubIssueComment>(
      `${baseUrl}/issues/${encodeURIComponent(String(existing.number))}/comments`,
      fetcher,
      { token: options.token, method: "POST", body: { body } },
    );
    return { number: existing.number, created: false, action: "commented" };
  }

  const created = await requestJson<GitHubIssue>(
    `${baseUrl}/issues`,
    fetcher,
    {
      token: options.token,
      method: "POST",
      body: {
        title: MAIN_GUARD_ISSUE_TITLE,
        body,
        assignees: [owner],
      },
    },
  );
  if (!Number.isInteger(created.number)) {
    throw new Error("GitHub API created an issue without a valid issue number");
  }
  return { number: created.number, created: true, action: "created" };
}

async function runFromGitHubActions(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.error("main-guard failed closed: GITHUB_EVENT_PATH is missing");
    process.exitCode = 1;
    return;
  }

  let event: MainPushEvent;
  try {
    event = JSON.parse(readFileSync(eventPath, "utf8")) as MainPushEvent;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid event payload";
    console.error(`main-guard failed closed: ${message}`);
    process.exitCode = 1;
    return;
  }

  const eventName = process.env.GITHUB_EVENT_NAME ?? "push";
  event.ref ??= process.env.GITHUB_REF;
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  const mainSha = event.after ?? process.env.GITHUB_SHA ?? "unknown";
  let failures: string[];

  try {
    failures = await getMainGuardFailures(event, {
      repository,
      token,
      apiUrl: process.env.GITHUB_API_URL,
      eventName,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected verification error";
    failures = [`main-guard verification failed closed: ${message}`];
  }

  if (failures.length > 0) {
    console.error("main-guard failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    try {
      const issue = await reportMainGuardFailure(failures, {
        repository,
        token,
        apiUrl: process.env.GITHUB_API_URL,
        mainSha,
        before: event.before,
        eventName,
        actor: process.env.GITHUB_ACTOR,
        runUrl:
          process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
            ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
            : undefined,
      });
      if (issue.action === "created") {
        console.error(
          `main-guard opened issue #${issue.number} and assigned it to ${repositoryParts(repository)?.[0] ?? "the repository owner"}`,
        );
      } else if (issue.action === "commented") {
        console.error(`main-guard added a new violation to open issue #${issue.number}`);
      } else {
        console.error(`main-guard skipped duplicate violation in open issue #${issue.number}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "issue reporting failed";
      console.error(`main-guard could not open an issue: ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("main-guard passed: first-parent history, PR checks, full e2e, and deployedSha are valid.");
}

if (import.meta.main) {
  await runFromGitHubActions();
}
