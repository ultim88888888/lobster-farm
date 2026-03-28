import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { PRReviewCron } from "../pr-cron.js";

// ── Helpers ──

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
  });
}

/** ISO timestamps for test scenarios. Spaced apart to be clearly outside the 60s buffer. */
const T = {
  review:       "2026-03-27T10:00:00Z",
  commit_old:   "2026-03-27T09:00:00Z",  // 1h before review
  commit_new:   "2026-03-27T11:00:00Z",  // 1h after review
  commit_close: "2026-03-27T10:00:30Z",  // 30s after review (within 60s buffer)
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
    reviews: (opts.reviews ?? []).map(r => ({
      submittedAt: r.submittedAt,
      author: { login: r.login ?? "reviewer-bot" },
      state: r.state ?? "COMMENTED",
    })),
    comments: (opts.comments ?? []).map(c => ({
      createdAt: c.createdAt,
      author: { login: c.login ?? "reviewer-bot" },
    })),
    commits: (opts.commits ?? []).map(c => ({
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
    cron.set_feedback(42, make_pr_data({
      reviews: [],
      comments: [],
      commits: [{ committedDate: T.commit_new }],
    }));

    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(false);
  });

  it("skips PR with review and no new commits", async () => {
    cron.set_feedback(42, make_pr_data({
      reviews: [{ submittedAt: T.review }],
      comments: [],
      commits: [{ committedDate: T.commit_old }],
    }));

    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(true);
  });

  it("does not skip PR with review followed by new commits", async () => {
    cron.set_feedback(42, make_pr_data({
      reviews: [{ submittedAt: T.review }],
      comments: [],
      commits: [
        { committedDate: T.commit_old },
        { committedDate: T.commit_new },
      ],
    }));

    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(false);
  });

  it("skips when commit is within the 60s timestamp buffer", async () => {
    cron.set_feedback(42, make_pr_data({
      reviews: [{ submittedAt: T.review }],
      comments: [],
      commits: [{ committedDate: T.commit_close }],
    }));

    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(true);
  });

  it("does not skip when commit is just past the 60s buffer", async () => {
    // 61s after review — just past the buffer
    const commit_past_buffer = "2026-03-27T10:01:01Z";
    cron.set_feedback(42, make_pr_data({
      reviews: [{ submittedAt: T.review }],
      comments: [],
      commits: [{ committedDate: commit_past_buffer }],
    }));

    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(false);
  });

  it("uses comment timestamps when no formal reviews exist", async () => {
    cron.set_feedback(42, make_pr_data({
      reviews: [],
      comments: [{ createdAt: T.review }],
      commits: [{ committedDate: T.commit_old }],
    }));

    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(true);
  });

  it("compares against the LATEST feedback across reviews and comments", async () => {
    const early_review = "2026-03-27T08:00:00Z";
    const late_comment = "2026-03-27T12:00:00Z";
    const mid_commit = "2026-03-27T11:00:00Z";

    cron.set_feedback(42, make_pr_data({
      reviews: [{ submittedAt: early_review }],
      comments: [{ createdAt: late_comment }],
      commits: [{ committedDate: mid_commit }],
    }));

    // Latest feedback (comment at 12:00) is after latest commit (11:00) — skip
    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(true);
  });

  it("handles multiple review rounds — compares against latest", async () => {
    cron.set_feedback(42, make_pr_data({
      // Round 1: review + comment, then fix
      // Round 2: re-review + comment, then another fix
      reviews: [
        { submittedAt: "2026-03-27T08:00:00Z" },
        { submittedAt: "2026-03-27T10:00:00Z" },
      ],
      comments: [
        { createdAt: "2026-03-27T08:30:00Z" },
        { createdAt: "2026-03-27T10:30:00Z" },
      ],
      commits: [
        { committedDate: "2026-03-27T07:00:00Z" },
        { committedDate: "2026-03-27T09:00:00Z" },
        { committedDate: "2026-03-27T11:30:00Z" }, // newest, after all feedback
      ],
    }));

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
    cron.set_feedback(42, make_pr_data({
      reviews: [{ submittedAt: T.review }],
      comments: [],
      commits: [],
    }));

    const skip = await cron.test_should_skip_pr(42);
    expect(skip).toBe(false);
  });

  it("logs re-review reason when commits are newer", async () => {
    cron.set_feedback(42, make_pr_data({
      reviews: [{ submittedAt: T.review }],
      comments: [],
      commits: [{ committedDate: T.commit_new }],
    }));

    await cron.test_should_skip_pr(42);

    const log_messages = log_spy.mock.calls.map(c => c[0]) as string[];
    expect(log_messages.some(m =>
      typeof m === "string" && m.includes("PR #42") && m.includes("needs re-review"),
    )).toBe(true);
  });

  it("logs skip reason when already reviewed", async () => {
    cron.set_feedback(42, make_pr_data({
      reviews: [{ submittedAt: T.review }],
      comments: [],
      commits: [{ committedDate: T.commit_old }],
    }));

    await cron.test_should_skip_pr(42);

    const log_messages = log_spy.mock.calls.map(c => c[0]) as string[];
    expect(log_messages.some(m =>
      typeof m === "string" && m.includes("PR #42") && m.includes("already reviewed"),
    )).toBe(true);
  });
});
