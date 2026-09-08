import { EntityConfigSchema, LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordBot } from "../discord.js";
import type { ProcessedPR } from "../persistence.js";
import { PRReviewCron } from "../pr-cron.js";

// ── Helpers ──

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
  });
}

/** ISO timestamps for test scenarios. Spaced apart to be clearly outside the 60s buffer. */
const T = {
  review: "2026-03-27T10:00:00Z",
  commit_old: "2026-03-27T09:00:00Z", // 1h before review
  commit_new: "2026-03-27T11:00:00Z", // 1h after review
  commit_close: "2026-03-27T10:00:30Z", // 30s after review (within 60s buffer)
};

/** Shape matching the private PRFeedbackData interface. */
interface FeedbackData {
  reviews: Array<{ submittedAt: string; author: { login: string }; state: string }>;
  comments: Array<{ createdAt: string; author: { login: string } }>;
  commits: Array<{ committedDate: string }>;
}

/** Build a PRFeedbackData object for test scenarios. */
function make_pr_data(opts: {
  reviews?: Array<{ submittedAt: string; login?: string; state?: string }>;
  comments?: Array<{ createdAt: string; login?: string }>;
  commits?: Array<{ committedDate: string }>;
}): FeedbackData {
  return {
    reviews: (opts.reviews ?? []).map((r) => ({
      submittedAt: r.submittedAt,
      author: { login: r.login ?? "reviewer-bot" },
      state: r.state ?? "COMMENTED",
    })),
    comments: (opts.comments ?? []).map((c) => ({
      createdAt: c.createdAt,
      author: { login: c.login ?? "reviewer-bot" },
    })),
    commits: (opts.commits ?? []).map((c) => ({
      committedDate: c.committedDate,
    })),
  };
}

/**
 * Test-friendly subclass that overrides the protected fetch_pr_feedback method
 * to return canned data instead of calling `gh` CLI. This follows the same
 * pattern as TestBotPool overriding is_bot_idle.
 */
class TestPRReviewCron extends PRReviewCron {
  private feedback_responses = new Map<number, FeedbackData | null>();

  constructor() {
    const config = make_config();
    super(
      { get_active: () => [] } as never,
      { spawn: vi.fn(), on: vi.fn(), removeListener: vi.fn() } as never,
      config,
      null,
      null,
    );
  }

  /** Set the feedback data to return for a specific PR number. */
  set_feedback(pr_number: number, data: FeedbackData | null): void {
    this.feedback_responses.set(pr_number, data);
  }

  /** Override to return canned data instead of calling gh CLI. */
  protected override async fetch_pr_feedback(
    _repo_path: string,
    pr_number: number,
  ): Promise<FeedbackData | null> {
    const response = this.feedback_responses.get(pr_number);
    // If no response set, return null (simulates gh CLI error)
    if (response === undefined) return null;
    return response;
  }

  /**
   * Expose the private should_skip_pr for direct testing.
   * Uses bracket notation to call the private method.
   */
  async test_should_skip_pr(pr_number: number): Promise<boolean> {
    type SkipFn = (repo_path: string, pr_number: number) => Promise<boolean>;
    const fn = (this as unknown as { should_skip_pr: SkipFn }).should_skip_pr.bind(this);
    return fn("/test/repo", pr_number);
  }
}

// ── Tests ──

describe("PRReviewCron.should_skip_pr", () => {
  let cron: TestPRReviewCron;
  let log_spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cron = new TestPRReviewCron();
    log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log_spy.mockRestore();
  });

  it("does not skip PR with no reviews or comments (never reviewed)", async () => {
    cron.set_feedback(
      42,
      make_pr_data({
        reviews: [],
        comments: [],
        commits: [{ committedDate: T.commit_new }],
      }),
    );

    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(false);
  });

  it("skips PR with review and no new commits", async () => {
    cron.set_feedback(
      42,
      make_pr_data({
        reviews: [{ submittedAt: T.review }],
        comments: [],
        commits: [{ committedDate: T.commit_old }],
      }),
    );

    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(true);
  });

  it("does not skip PR with review followed by new commits", async () => {
    cron.set_feedback(
      42,
      make_pr_data({
        reviews: [{ submittedAt: T.review }],
        comments: [],
        commits: [{ committedDate: T.commit_old }, { committedDate: T.commit_new }],
      }),
    );

    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(false);
  });

  it("skips when commit is within the 60s timestamp buffer", async () => {
    cron.set_feedback(
      42,
      make_pr_data({
        reviews: [{ submittedAt: T.review }],
        comments: [],
        commits: [{ committedDate: T.commit_close }],
      }),
    );

    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(true);
  });

  it("does not skip when commit is just past the 60s buffer", async () => {
    // 61s after review — just past the buffer
    const commit_past_buffer = "2026-03-27T10:01:01Z";
    cron.set_feedback(
      42,
      make_pr_data({
        reviews: [{ submittedAt: T.review }],
        comments: [],
        commits: [{ committedDate: commit_past_buffer }],
      }),
    );

    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(false);
  });

  it("uses comment timestamps when no formal reviews exist", async () => {
    cron.set_feedback(
      42,
      make_pr_data({
        reviews: [],
        comments: [{ createdAt: T.review }],
        commits: [{ committedDate: T.commit_old }],
      }),
    );

    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(true);
  });

  it("compares against the LATEST feedback across reviews and comments", async () => {
    const early_review = "2026-03-27T08:00:00Z";
    const late_comment = "2026-03-27T12:00:00Z";
    const mid_commit = "2026-03-27T11:00:00Z";

    cron.set_feedback(
      42,
      make_pr_data({
        reviews: [{ submittedAt: early_review }],
        comments: [{ createdAt: late_comment }],
        commits: [{ committedDate: mid_commit }],
      }),
    );

    // Latest feedback (comment at 12:00) is after latest commit (11:00) — skip
    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(true);
  });

  it("handles multiple review rounds — compares against latest", async () => {
    cron.set_feedback(
      42,
      make_pr_data({
        // Round 1: review + comment, then fix
        // Round 2: re-review + comment, then another fix
        reviews: [{ submittedAt: "2026-03-27T08:00:00Z" }, { submittedAt: "2026-03-27T10:00:00Z" }],
        comments: [{ createdAt: "2026-03-27T08:30:00Z" }, { createdAt: "2026-03-27T10:30:00Z" }],
        commits: [
          { committedDate: "2026-03-27T07:00:00Z" },
          { committedDate: "2026-03-27T09:00:00Z" },
          { committedDate: "2026-03-27T11:30:00Z" }, // newest, after all feedback
        ],
      }),
    );

    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(false); // newest commit is after latest feedback (10:30)
  });

  it("does not skip on gh CLI error (fail-open)", async () => {
    // No feedback set — simulates gh error (returns null)
    const skip = await cron.test_should_skip_pr(99);
    expect(skip).toBe(false);
  });

  it("does not skip when explicitly set to null (gh error)", async () => {
    cron.set_feedback(42, null);

    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(false);
  });

  it("does not skip when commits array is empty", async () => {
    cron.set_feedback(
      42,
      make_pr_data({
        reviews: [{ submittedAt: T.review }],
        comments: [],
        commits: [],
      }),
    );

    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(false);
  });

  it("logs re-review reason when commits are newer", async () => {
    cron.set_feedback(
      42,
      make_pr_data({
        reviews: [{ submittedAt: T.review }],
        comments: [],
        commits: [{ committedDate: T.commit_new }],
      }),
    );

    await cron.test_should_skip_pr(42);

    const log_messages = log_spy.mock.calls.map((c) => c[0]) as string[];
    expect(
      log_messages.some(
        (m) => typeof m === "string" && m.includes("PR #42") && m.includes("needs re-review"),
      ),
    ).toBe(true);
  });

  it("logs skip reason when already reviewed", async () => {
    cron.set_feedback(
      42,
      make_pr_data({
        reviews: [{ submittedAt: T.review }],
        comments: [],
        commits: [{ committedDate: T.commit_old }],
      }),
    );

    await cron.test_should_skip_pr(42);

    const log_messages = log_spy.mock.calls.map((c) => c[0]) as string[];
    expect(
      log_messages.some(
        (m) => typeof m === "string" && m.includes("PR #42") && m.includes("already reviewed"),
      ),
    ).toBe(true);
  });
});

// ── Repo path validation ──

// Mock persistence to avoid filesystem writes during test
vi.mock("../persistence.js", () => ({
  load_pr_reviews: vi.fn().mockResolvedValue({}),
  save_pr_reviews: vi.fn().mockResolvedValue(undefined),
}));

// Mock sentry to avoid real Sentry calls
vi.mock("../sentry.js", () => ({
  cronCheckInStart: vi.fn().mockReturnValue("test-checkin-id"),
  cronCheckInFinish: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

// Mock actions to avoid real execFile calls
vi.mock("../actions.js", () => ({
  detect_review_outcome: vi.fn().mockResolvedValue("approved"),
}));

// Mock review-utils for retry_approved_unmerged and spawn_ci_fixer tests
vi.mock("../review-utils.js", () => ({
  fetch_review_comments: vi.fn().mockResolvedValue("review comments"),
  build_review_fix_prompt: vi.fn().mockReturnValue("fix prompt"),
  attempt_auto_merge: vi.fn().mockResolvedValue({ merged: true, method: "direct" }),
  check_ci_status: vi
    .fn()
    .mockResolvedValue({ passed: true, pending: false, failures: [], source: "pr-checks" }),
  fetch_ci_failure_logs: vi.fn().mockResolvedValue([]),
  build_ci_fix_prompt: vi.fn().mockReturnValue("ci fix prompt"),
  MAX_CI_FIX_ATTEMPTS: 3,
}));

function make_entity_with_repo(repo_path: string): EntityConfig {
  return EntityConfigSchema.parse({
    entity: {
      id: "test-entity",
      name: "Test Entity",
      status: "active",
      repos: [{ name: "test", url: "git@github.com:test/test.git", path: repo_path }],
      accounts: {},
      channels: { category_id: "cat-1", list: [] },
      memory: { path: "/tmp/memory" },
      secrets: { vault: "1password", vault_name: "test" },
    },
  });
}

describe("PRReviewCron — repo path validation", () => {
  let log_spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log_spy.mockRestore();
  });

  it("skips repos with non-existent paths without calling gh", async () => {
    const mock_registry = {
      get_active: () => [make_entity_with_repo("/tmp/does-not-exist-xyz-9999")],
      get: vi.fn(),
    };

    const cron = new PRReviewCron(
      mock_registry as never,
      { spawn: vi.fn(), on: vi.fn(), removeListener: vi.fn() } as never,
      make_config(),
      null,
      null,
    );

    // Start the cron — this triggers an immediate poll
    await cron.start(999_999_999); // Very long interval so only the immediate poll fires
    cron.stop();

    // Give the immediate poll a tick to execute
    await new Promise((resolve) => setTimeout(resolve, 50));

    const log_messages = log_spy.mock.calls.map((c) => c[0]) as string[];
    expect(
      log_messages.some(
        (m) =>
          typeof m === "string" &&
          m.includes("Repo path does not exist") &&
          m.includes("test-entity"),
      ),
    ).toBe(true);

    // Should NOT have "Could not list PRs" — we should skip before calling gh
    expect(
      log_messages.some((m) => typeof m === "string" && m.includes("Could not list PRs")),
    ).toBe(false);
  });

  it("resolves gh binary to absolute path on start", async () => {
    const mock_registry = {
      get_active: () => [],
      get: vi.fn(),
    };

    const cron = new PRReviewCron(
      mock_registry as never,
      { spawn: vi.fn(), on: vi.fn(), removeListener: vi.fn() } as never,
      make_config(),
      null,
      null,
    );

    await cron.start(999_999_999);
    cron.stop();

    const log_messages = log_spy.mock.calls.map((c) => c[0]) as string[];
    expect(
      log_messages.some((m) => typeof m === "string" && m.includes("Resolved gh binary:")),
    ).toBe(true);
  });
});

// ── retry_approved_unmerged tests (#189) ──

import { detect_review_outcome } from "../actions.js";
import { save_pr_reviews } from "../persistence.js";
import { attempt_auto_merge, check_ci_status } from "../review-utils.js";

const mock_check_ci = vi.mocked(check_ci_status);
const mock_auto_merge = vi.mocked(attempt_auto_merge);
const mock_detect_outcome = vi.mocked(detect_review_outcome);
const mock_save_reviews = vi.mocked(save_pr_reviews);

/** Shape matching the private OpenPR interface in pr-cron.ts. */
interface TestOpenPR {
  number: number;
  title: string;
  headRefName: string;
  updatedAt: string;
  url: string;
  body: string;
  author: { login: string };
}

function make_test_pr(overrides: Partial<TestOpenPR> = {}): TestOpenPR {
  return {
    number: 42,
    title: "feat: test feature",
    headRefName: "feature/test",
    updatedAt: "2026-03-27T10:00:00Z",
    url: "https://github.com/test/test/pull/42",
    body: "Test PR body",
    author: { login: "test-user" },
    ...overrides,
  };
}

function make_entity_with_github_user(github_user: string): EntityConfig {
  return EntityConfigSchema.parse({
    entity: {
      id: "test-entity",
      name: "Test Entity",
      status: "active",
      repos: [{ name: "test", url: "git@github.com:test/test.git", path: "/tmp/test-repo" }],
      accounts: { github: { user: github_user } },
      channels: { category_id: "cat-1", list: [] },
      memory: { path: "/tmp/memory" },
      secrets: { vault: "1password", vault_name: "test" },
    },
  });
}

/**
 * Create a PRReviewCron instance with private methods patched for testing
 * the retry_approved_unmerged pass without needing real gh CLI calls.
 */
function make_mock_alert_router() {
  return {
    post_alert: vi.fn().mockResolvedValue({ message_id: null }),
    resolve_incident: vi.fn().mockResolvedValue(undefined),
  };
}

function make_retry_test_cron(
  opts: {
    discord?: DiscordBot | null;
    processed?: Record<string, ProcessedPR>;
    pr_merged?: Map<number, boolean>;
  } = {},
): {
  cron: PRReviewCron;
  alert_router: ReturnType<typeof make_mock_alert_router>;
  get_processed: () => Record<string, ProcessedPR>;
  call_retry: (
    entity_id: string,
    repo_path: string,
    prs: TestOpenPR[],
    entity_config: EntityConfig,
  ) => Promise<void>;
} {
  const config = make_config();
  const alert_router = make_mock_alert_router();
  const cron = new PRReviewCron(
    { get_active: () => [], get: vi.fn() } as never,
    { spawn: vi.fn(), on: vi.fn(), removeListener: vi.fn() } as never,
    config,
    opts.discord ?? null,
    null, // github_app
    null, // pr_watches
    alert_router as never,
  );

  // Patch private methods that require gh CLI or GitHub App auth
  const cron_any = cron as unknown as Record<string, unknown>;

  // resolve_entity_token — return a dummy token
  cron_any.resolve_entity_token = vi.fn().mockResolvedValue("ghs_test_token");

  // check_pr_merged — controllable per PR number
  const merge_map = opts.pr_merged ?? new Map();
  cron_any.check_pr_merged = vi
    .fn()
    .mockImplementation(
      async (_path: string, pr_number: number) => merge_map.get(pr_number) ?? false,
    );

  // close_issues_for_merged_pr — no-op
  cron_any.close_issues_for_merged_pr = vi.fn().mockResolvedValue(undefined);

  // Seed processed state
  if (opts.processed) {
    cron_any.processed = { ...opts.processed };
  }

  return {
    cron,
    alert_router,
    get_processed: () => cron_any.processed as Record<string, ProcessedPR>,
    call_retry: (entity_id, repo_path, prs, entity_config) =>
      (
        cron_any.retry_approved_unmerged as (
          entity_id: string,
          repo_path: string,
          prs: TestOpenPR[],
          entity_config: EntityConfig,
        ) => Promise<void>
      ).call(cron, entity_id, repo_path, prs, entity_config),
  };
}

describe("PRReviewCron.retry_approved_unmerged", () => {
  let log_spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    log_spy.mockRestore();
  });

  const entity_id = "test-entity";
  const repo_path = "/tmp/test-repo";

  it("merges when processed has approved entry and CI passes", async () => {
    const pr = make_test_pr({ author: { login: "test-user" } });
    const entity_config = make_entity_with_github_user("test-user");

    mock_check_ci.mockResolvedValueOnce({
      passed: true,
      pending: false,
      failures: [],
      source: "pr-checks",
    });
    mock_auto_merge.mockResolvedValueOnce({ merged: true, method: "direct" });

    const { call_retry, get_processed } = make_retry_test_cron({
      processed: {
        [`${entity_id}:42`]: {
          entity_id,
          pr_number: 42,
          reviewed_at: "2026-03-27T10:00:00Z",
          outcome: "approved",
        },
      },
    });

    await call_retry(entity_id, repo_path, [pr], entity_config);

    expect(mock_check_ci).toHaveBeenCalledWith(42, repo_path, "ghs_test_token", "gh");
    expect(mock_auto_merge).toHaveBeenCalledWith(
      42,
      "feature/test",
      repo_path,
      "gh",
      "ghs_test_token",
    );
    expect(mock_save_reviews).toHaveBeenCalled();
    expect(get_processed()[`${entity_id}:42`]?.outcome).toBe("approved");
  });

  it("skips merge when CI is still pending", async () => {
    const pr = make_test_pr({ author: { login: "test-user" } });
    const entity_config = make_entity_with_github_user("test-user");

    mock_check_ci.mockResolvedValueOnce({
      passed: false,
      pending: true,
      failures: [],
      source: "pr-checks",
    });

    const { call_retry } = make_retry_test_cron({
      processed: {
        [`${entity_id}:42`]: {
          entity_id,
          pr_number: 42,
          reviewed_at: "2026-03-27T10:00:00Z",
          outcome: "approved",
        },
      },
    });

    await call_retry(entity_id, repo_path, [pr], entity_config);

    expect(mock_check_ci).toHaveBeenCalled();
    expect(mock_auto_merge).not.toHaveBeenCalled();

    const logs = log_spy.mock.calls.map((c) => c[0]) as string[];
    expect(
      logs.some(
        (m) => typeof m === "string" && m.includes("CI still pending") && m.includes("#42"),
      ),
    ).toBe(true);
  });

  it("spawns CI fixer when CI has failures and records failure set in processed", async () => {
    const pr = make_test_pr({ author: { login: "test-user" } });
    const entity_config = make_entity_with_github_user("test-user");

    mock_check_ci.mockResolvedValueOnce({
      passed: false,
      pending: false,
      failures: ["Build", "Test"],
    });

    const { alert_router, call_retry, get_processed } = make_retry_test_cron({
      processed: {
        [`${entity_id}:42`]: {
          entity_id,
          pr_number: 42,
          reviewed_at: "2026-03-27T10:00:00Z",
          outcome: "approved",
        },
      },
    });

    await call_retry(entity_id, repo_path, [pr], entity_config);

    expect(mock_auto_merge).not.toHaveBeenCalled();
    expect(alert_router.post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id,
        body: expect.stringContaining("spawning builder"),
      }),
    );

    // Should record the failure set for deduplication
    const processed = get_processed()[`${entity_id}:42`];
    expect(processed?.ci_failure_alerted).toBe(JSON.stringify(["Build", "Test"]));
    expect(mock_save_reviews).toHaveBeenCalled();
  });

  it("deduplicates CI failure alerts when same failure set repeats", async () => {
    const pr = make_test_pr({ author: { login: "test-user" } });
    const entity_config = make_entity_with_github_user("test-user");

    // Same failures as what's already recorded in ci_failure_alerted
    mock_check_ci.mockResolvedValueOnce({
      passed: false,
      pending: false,
      failures: ["Build", "Test"],
    });

    const { alert_router, call_retry } = make_retry_test_cron({
      processed: {
        [`${entity_id}:42`]: {
          entity_id,
          pr_number: 42,
          reviewed_at: "2026-03-27T10:00:00Z",
          outcome: "approved",
          ci_failure_alerted: JSON.stringify(["Build", "Test"]),
        },
      },
    });

    await call_retry(entity_id, repo_path, [pr], entity_config);

    // Should NOT alert again — same failure set
    expect(alert_router.post_alert).not.toHaveBeenCalled();
    expect(mock_auto_merge).not.toHaveBeenCalled();
  });

  it("re-spawns CI fixer when failure set changes", async () => {
    const pr = make_test_pr({ author: { login: "test-user" } });
    const entity_config = make_entity_with_github_user("test-user");

    // Different failure set than what was previously alerted
    mock_check_ci.mockResolvedValueOnce({
      passed: false,
      pending: false,
      failures: ["Lint", "Deploy"],
    });

    const { alert_router, call_retry, get_processed } = make_retry_test_cron({
      processed: {
        [`${entity_id}:42`]: {
          entity_id,
          pr_number: 42,
          reviewed_at: "2026-03-27T10:00:00Z",
          outcome: "approved",
          ci_failure_alerted: JSON.stringify(["Build", "Test"]),
        },
      },
    });

    await call_retry(entity_id, repo_path, [pr], entity_config);

    // Should alert — different failure set
    expect(alert_router.post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id,
        body: expect.stringContaining("spawning builder"),
      }),
    );

    // Should update the recorded failure set
    const processed = get_processed()[`${entity_id}:42`];
    expect(processed?.ci_failure_alerted).toBe(JSON.stringify(["Deploy", "Lint"]));
  });

  it("checks GitHub API for approval when no processed entry (webhook handler path)", async () => {
    const pr = make_test_pr({ author: { login: "test-user" } });
    const entity_config = make_entity_with_github_user("test-user");

    // No processed entry — simulate webhook handler path
    mock_detect_outcome.mockResolvedValueOnce("approved");
    mock_check_ci.mockResolvedValueOnce({
      passed: true,
      pending: false,
      failures: [],
      source: "pr-checks",
    });
    mock_auto_merge.mockResolvedValueOnce({ merged: true, method: "direct" });

    const { call_retry } = make_retry_test_cron({
      processed: {}, // empty — webhook handler doesn't write to processed
    });

    await call_retry(entity_id, repo_path, [pr], entity_config);

    expect(mock_detect_outcome).toHaveBeenCalledWith(42, repo_path, "ghs_test_token");
    expect(mock_auto_merge).toHaveBeenCalled();
  });

  it("skips external PRs (different author than github_user)", async () => {
    const pr = make_test_pr({ author: { login: "external-contributor" } });
    const entity_config = make_entity_with_github_user("test-user");

    const { call_retry } = make_retry_test_cron({
      processed: {
        [`${entity_id}:42`]: {
          entity_id,
          pr_number: 42,
          reviewed_at: "2026-03-27T10:00:00Z",
          outcome: "approved",
        },
      },
    });

    await call_retry(entity_id, repo_path, [pr], entity_config);

    // Should not even check CI for external PRs
    expect(mock_check_ci).not.toHaveBeenCalled();
    expect(mock_auto_merge).not.toHaveBeenCalled();
  });

  it("skips PRs with changes_requested outcome", async () => {
    const pr = make_test_pr({ author: { login: "test-user" } });
    const entity_config = make_entity_with_github_user("test-user");

    const { call_retry } = make_retry_test_cron({
      processed: {
        [`${entity_id}:42`]: {
          entity_id,
          pr_number: 42,
          reviewed_at: "2026-03-27T10:00:00Z",
          outcome: "changes_requested",
        },
      },
    });

    await call_retry(entity_id, repo_path, [pr], entity_config);

    expect(mock_check_ci).not.toHaveBeenCalled();
  });

  it("cleans up processed entry when PR was already merged", async () => {
    const pr = make_test_pr({ author: { login: "test-user" } });
    const entity_config = make_entity_with_github_user("test-user");

    const { call_retry, get_processed } = make_retry_test_cron({
      processed: {
        [`${entity_id}:42`]: {
          entity_id,
          pr_number: 42,
          reviewed_at: "2026-03-27T10:00:00Z",
          outcome: "approved",
        },
      },
      pr_merged: new Map([[42, true]]),
    });

    await call_retry(entity_id, repo_path, [pr], entity_config);

    // Should clean up the processed entry since PR is already merged
    expect(get_processed()[`${entity_id}:42`]).toBeUndefined();
    expect(mock_save_reviews).toHaveBeenCalled();
    // Should NOT attempt merge
    expect(mock_auto_merge).not.toHaveBeenCalled();
  });
});

// ── pr-cron spawn_ci_fixer tests (#196) ──

import { build_ci_fix_prompt, fetch_ci_failure_logs } from "../review-utils.js";

const mock_fetch_ci_logs = vi.mocked(fetch_ci_failure_logs);
const mock_build_ci_prompt = vi.mocked(build_ci_fix_prompt);

/**
 * Create a PRReviewCron instance with private methods patched for testing
 * the spawn_ci_fixer path directly.
 */
function make_ci_fixer_test_cron(
  opts: {
    processed?: Record<string, ProcessedPR>;
    token_error?: Error;
  } = {},
): {
  cron: PRReviewCron;
  session_manager: { spawn: ReturnType<typeof vi.fn> };
  alert_router: ReturnType<typeof make_mock_alert_router>;
  get_processed: () => Record<string, ProcessedPR>;
  get_active_reviews: () => Map<string, unknown>;
  resolve_entity_token: ReturnType<typeof vi.fn>;
  call_spawn_ci_fixer: (
    entity_id: string,
    repo_path: string,
    pr: TestOpenPR,
    failed_checks: string[],
    entity_config?: EntityConfig,
  ) => Promise<boolean>;
} {
  const config = make_config();
  const alert_router = make_mock_alert_router();
  const mock_spawn = vi.fn().mockResolvedValue({
    session_id: "ci-fix-session-123",
    entity_id: "test-entity",
    feature_id: "ci-fix-42",
    archetype: "builder",
    started_at: new Date(),
    pid: 99999,
  });
  const session_manager = {
    spawn: mock_spawn,
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const cron = new PRReviewCron(
    { get_active: () => [], get: vi.fn() } as never,
    session_manager as never,
    config,
    null, // discord
    null, // github_app
    null, // pr_watches
    alert_router as never,
  );

  const cron_any = cron as unknown as Record<string, unknown>;

  // resolve_entity_token — return a dummy token or reject with error
  const resolve_token_mock = opts.token_error
    ? vi.fn().mockRejectedValue(opts.token_error)
    : vi.fn().mockResolvedValue("ghs_test_token");
  cron_any.resolve_entity_token = resolve_token_mock;

  // Seed processed state
  if (opts.processed) {
    cron_any.processed = { ...opts.processed };
  }

  return {
    cron,
    session_manager,
    alert_router,
    get_processed: () => cron_any.processed as Record<string, ProcessedPR>,
    get_active_reviews: () => cron_any.active_reviews as Map<string, unknown>,
    resolve_entity_token: resolve_token_mock,
    call_spawn_ci_fixer: (entity_id, repo_path, pr, failed_checks, entity_config) =>
      (
        cron_any.spawn_ci_fixer as (
          entity_id: string,
          repo_path: string,
          pr: TestOpenPR,
          failed_checks: string[],
          entity_config?: EntityConfig,
        ) => Promise<boolean>
      ).call(cron, entity_id, repo_path, pr, failed_checks, entity_config),
  };
}

describe("PRReviewCron.spawn_ci_fixer", () => {
  let log_spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    log_spy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    log_spy.mockRestore();
  });

  const entity_id = "test-entity";
  const repo_path = "/tmp/test-repo";

  it("spawns a builder and increments ci_fix_attempts", async () => {
    const pr = make_test_pr();
    const entity_config = make_entity_with_github_user("test-user");

    const { session_manager, get_processed, call_spawn_ci_fixer } = make_ci_fixer_test_cron({
      processed: {
        [`${entity_id}:42`]: {
          entity_id,
          pr_number: 42,
          reviewed_at: "2026-03-27T10:00:00Z",
          outcome: "approved",
        },
      },
    });

    await call_spawn_ci_fixer(entity_id, repo_path, pr, ["Build"], entity_config);

    expect(session_manager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id,
        feature_id: "ci-fix-42",
        archetype: "builder",
      }),
    );

    const processed = get_processed()[`${entity_id}:42`];
    expect(processed?.ci_fix_attempts).toBe(1);
  });

  it("stops spawning after MAX_CI_FIX_ATTEMPTS and escalates", async () => {
    const pr = make_test_pr();
    const entity_config = make_entity_with_github_user("test-user");

    const { alert_router, session_manager, call_spawn_ci_fixer } = make_ci_fixer_test_cron({
      processed: {
        [`${entity_id}:42`]: {
          entity_id,
          pr_number: 42,
          reviewed_at: "2026-03-27T10:00:00Z",
          outcome: "approved",
          ci_fix_attempts: 3,
        },
      },
    });

    await call_spawn_ci_fixer(entity_id, repo_path, pr, ["Build"], entity_config);

    // Should NOT spawn a builder
    expect(session_manager.spawn).not.toHaveBeenCalled();

    // Should alert about max attempts
    expect(alert_router.post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id,
        tier: "action_required",
        body: expect.stringContaining("failed after 3 attempts"),
      }),
    );
  });

  it("skips when active_reviews has the PR (dedup)", async () => {
    const pr = make_test_pr();
    const entity_config = make_entity_with_github_user("test-user");

    const { session_manager, get_active_reviews, call_spawn_ci_fixer } = make_ci_fixer_test_cron({
      processed: {
        [`${entity_id}:42`]: {
          entity_id,
          pr_number: 42,
          reviewed_at: "2026-03-27T10:00:00Z",
          outcome: "approved",
        },
      },
    });

    // Simulate an in-flight review for this PR
    get_active_reviews().set(`${entity_id}:42`, {
      pr_number: 42,
      entity_id,
      repo_url: "https://github.com/test/test/pull/42",
      status: "reviewing",
      last_checked: new Date(),
    });

    await call_spawn_ci_fixer(entity_id, repo_path, pr, ["Build"], entity_config);

    // Should NOT spawn — dedup
    expect(session_manager.spawn).not.toHaveBeenCalled();

    const logs = log_spy.mock.calls.map((c) => c[0]) as string[];
    expect(
      logs.some(
        (m) =>
          typeof m === "string" && m.includes("CI fix skipped") && m.includes("already in-flight"),
      ),
    ).toBe(true);
  });

  it("sets ci_failure_alerted to prevent double-spawn from retry pass", async () => {
    const pr = make_test_pr();
    const entity_config = make_entity_with_github_user("test-user");

    const { get_processed, call_spawn_ci_fixer } = make_ci_fixer_test_cron({
      processed: {
        [`${entity_id}:42`]: {
          entity_id,
          pr_number: 42,
          reviewed_at: "2026-03-27T10:00:00Z",
          outcome: "approved",
        },
      },
    });

    await call_spawn_ci_fixer(entity_id, repo_path, pr, ["Lint", "Build"], entity_config);

    const processed = get_processed()[`${entity_id}:42`];
    // ci_failure_alerted should be set with sorted failure names
    expect(processed?.ci_failure_alerted).toBe(JSON.stringify(["Build", "Lint"]));
  });

  it("does not consume retry slot on token resolution failure", async () => {
    const pr = make_test_pr();
    const entity_config = make_entity_with_github_user("test-user");

    const { session_manager, get_processed, call_spawn_ci_fixer } = make_ci_fixer_test_cron({
      processed: {
        [`${entity_id}:42`]: {
          entity_id,
          pr_number: 42,
          reviewed_at: "2026-03-27T10:00:00Z",
          outcome: "approved",
        },
      },
      token_error: new Error("Certificate expired"),
    });

    const result = await call_spawn_ci_fixer(entity_id, repo_path, pr, ["Build"], entity_config);

    // Should NOT spawn a builder
    expect(session_manager.spawn).not.toHaveBeenCalled();

    // Should return false so caller doesn't mark ci_failure_alerted
    expect(result).toBe(false);

    // ci_fix_attempts should NOT have been incremented
    const processed = get_processed()[`${entity_id}:42`];
    expect(processed?.ci_fix_attempts ?? 0).toBe(0);
  });

  it("returns true when spawn succeeds", async () => {
    const pr = make_test_pr();
    const entity_config = make_entity_with_github_user("test-user");

    const { call_spawn_ci_fixer } = make_ci_fixer_test_cron({
      processed: {
        [`${entity_id}:42`]: {
          entity_id,
          pr_number: 42,
          reviewed_at: "2026-03-27T10:00:00Z",
          outcome: "approved",
        },
      },
    });

    const result = await call_spawn_ci_fixer(entity_id, repo_path, pr, ["Build"], entity_config);
    expect(result).toBe(true);
  });
});
