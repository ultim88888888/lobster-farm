/**
 * Tests for handle_v2_review_completion (#257).
 *
 * This function is the v2 post-review dispatcher: after a reviewer completes,
 * it routes the outcome (approved, changes_requested, pending) to the
 * merge-gate or builder-spawn path. It's the critical merge path — a bug here
 * silently drops PRs.
 *
 * Mock strategy: module-level vi.mock for all external calls (merge-gate,
 * review-utils, check-suite-handler persistence, issue-utils, worktree-cleanup,
 * sentry). The function takes a WebhookContext which carries discord/pr_watches/
 * session_manager — we stub those inline.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock merge-gate BEFORE importing the function under test
vi.mock("../merge-gate.js", () => ({
  run_merge_gate: vi.fn(async () => ({ kind: "merged", method: "direct" })),
}));

vi.mock("../review-utils.js", () => ({
  fetch_review_comments: vi.fn(async () => "Please fix the tests."),
  build_review_fix_prompt: vi.fn(() => "fix prompt"),
  check_merge_conflicts: vi.fn(async () => false),
  attempt_auto_merge: vi.fn(async () => ({ merged: true, method: "direct" })),
  check_ci_status: vi.fn(async () => ({
    passed: true,
    pending: false,
    failures: [],
    source: "pr-checks",
  })),
  fetch_pr_mergeability: vi.fn(async () => ({
    mergeable: "MERGEABLE",
    merge_state_status: "CLEAN",
    head_sha: "deadbeef",
  })),
  try_local_rebase: vi.fn(async () => ({ success: true })),
  fetch_ci_failure_logs: vi.fn(async () => []),
  build_ci_fix_prompt: vi.fn(() => "ci fix prompt"),
  build_deploy_triage_prompt: vi.fn(() => "deploy triage prompt"),
  MAX_CI_FIX_ATTEMPTS: 3,
  MAX_DEPLOY_FIX_ATTEMPTS: 2,
}));

vi.mock("../check-suite-handler.js", () => ({
  handle_check_suite: vi.fn(),
  make_default_deps: vi.fn(),
  record_v2_review_feedback: vi.fn(async () => {}),
}));

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock("../worktree-cleanup.js", () => ({
  cleanup_after_merge: vi.fn(async () => {}),
}));

vi.mock("../issue-utils.js", () => ({
  extract_first_linked_issue: vi.fn(() => null),
  extract_linked_issues: vi.fn(() => []),
  fetch_issue_context: vi.fn(async () => ""),
  close_linked_issues: vi.fn(async () => []),
  nwo_from_url: vi.fn(() => "test-org/test-repo"),
}));

vi.mock("../persistence.js", () => ({
  load_pr_reviews: vi.fn(async () => ({})),
  save_pr_reviews: vi.fn(async () => {}),
  load_deploy_triage: vi.fn(async () => []),
  save_deploy_triage: vi.fn(async () => {}),
}));

vi.mock("../actions.js", () => ({
  detect_review_outcome: vi.fn(async () => "approved"),
}));
import { record_v2_review_feedback } from "../check-suite-handler.js";
import { run_merge_gate } from "../merge-gate.js";
import { fetch_pr_mergeability } from "../review-utils.js";
import type { WebhookContext, WebhookPR } from "../webhook-handler.js";
import { handle_v2_review_completion } from "../webhook-handler.js";
import { cleanup_after_merge } from "../worktree-cleanup.js";

// ── Fixtures ──

const ENTITY_ID = "test-entity";
const REPO_PATH = "/tmp/test-repo";
const REPO_FULL_NAME = "test-org/test-repo";

function make_pr(overrides: Partial<WebhookPR> = {}): WebhookPR {
  return {
    number: 42,
    title: "Add feature X",
    head: { ref: "feature/42-x", sha: "abc12340" },
    body: "Closes #10",
    user: { login: "testuser" },
    ...overrides,
  };
}

function make_ctx(overrides: Partial<WebhookContext> = {}): WebhookContext {
  return {
    github_app: {
      verify_signature: vi.fn(),
      get_token: vi.fn().mockResolvedValue("ghs_mock_token"),
      get_token_for_installation: vi.fn().mockResolvedValue("ghs_install_token"),
    } as unknown as WebhookContext["github_app"],
    session_manager: {
      spawn: vi.fn().mockResolvedValue({
        session_id: "sess_123",
        entity_id: ENTITY_ID,
        feature_id: "fix-42",
        archetype: "builder",
        started_at: new Date(),
        pid: 12345,
      }),
      on: vi.fn(),
      emit: vi.fn(),
      get_active: vi.fn().mockReturnValue([]),
    } as unknown as WebhookContext["session_manager"],
    registry: {
      get_active: vi.fn().mockReturnValue([
        {
          entity: {
            id: ENTITY_ID,
            pr_lifecycle: "v2",
            repos: [
              {
                name: "test-repo",
                url: "https://github.com/test-org/test-repo.git",
                path: REPO_PATH,
              },
            ],
          },
        },
      ]),
    } as unknown as WebhookContext["registry"],
    discord: {
      send_to_entity: vi.fn(async () => {}),
    } as unknown as WebhookContext["discord"],
    config: {
      paths: { lobsterfarm_dir: "/tmp/lf", projects_dir: "/tmp" },
    } as WebhookContext["config"],
    pool: null,
    pr_watches: null,
    alert_router: {
      post_alert: vi.fn(async () => ({ message_id: null })),
    } as unknown as WebhookContext["alert_router"],
    ...overrides,
  };
}

// ── Silence console output from the handler ──

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ── Tests ──

describe("handle_v2_review_completion — changes_requested", () => {
  it("records feedback and spawns builder on changes_requested", async () => {
    const pr = make_pr();
    const ctx = make_ctx();

    await handle_v2_review_completion(
      ENTITY_ID,
      REPO_PATH,
      REPO_FULL_NAME,
      pr,
      "changes_requested",
      "ghs_token",
      ctx,
    );

    // Should record review feedback
    expect(record_v2_review_feedback).toHaveBeenCalledWith(
      ENTITY_ID,
      42,
      "deadbeef", // head_sha from mocked fetch_pr_mergeability
      expect.any(String), // feedback body from mocked fetch_review_comments
      ctx.config,
    );

    // Should spawn a builder (via spawn_fixer which uses session_manager.spawn)
    expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
    const spawn_call = (ctx.session_manager as any).spawn.mock.calls[0]![0];
    expect(spawn_call.archetype).toBe("builder");

    // Should alert via alert_router
    expect((ctx.alert_router as any).post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: ENTITY_ID,
        tier: "routine",
        title: expect.stringContaining("changes requested"),
      }),
    );

    // Should NOT call the merge-gate
    expect(run_merge_gate).not.toHaveBeenCalled();
  });

  it("still spawns builder even if feedback recording fails", async () => {
    vi.mocked(record_v2_review_feedback).mockRejectedValueOnce(
      new Error("persistence write failed"),
    );

    const pr = make_pr();
    const ctx = make_ctx();

    await handle_v2_review_completion(
      ENTITY_ID,
      REPO_PATH,
      REPO_FULL_NAME,
      pr,
      "changes_requested",
      "ghs_token",
      ctx,
    );

    // Builder should still be spawned
    expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
  });

  it("skips feedback recording when head_sha or review body is empty", async () => {
    vi.mocked(fetch_pr_mergeability).mockRejectedValueOnce(new Error("gh CLI error"));

    const pr = make_pr();
    const ctx = make_ctx();

    await handle_v2_review_completion(
      ENTITY_ID,
      REPO_PATH,
      REPO_FULL_NAME,
      pr,
      "changes_requested",
      "ghs_token",
      ctx,
    );

    // Feedback not recorded (head_sha is empty due to fetch failure)
    expect(record_v2_review_feedback).not.toHaveBeenCalled();

    // Builder should still be spawned
    expect((ctx.session_manager as any).spawn).toHaveBeenCalledTimes(1);
  });
});

describe("handle_v2_review_completion — approved", () => {
  it("runs merge-gate and calls cleanup on successful merge", async () => {
    vi.mocked(run_merge_gate).mockResolvedValueOnce({ kind: "merged", method: "direct" });

    const pr = make_pr();
    const ctx = make_ctx();

    await handle_v2_review_completion(
      ENTITY_ID,
      REPO_PATH,
      REPO_FULL_NAME,
      pr,
      "approved",
      "ghs_token",
      ctx,
    );

    expect(run_merge_gate).toHaveBeenCalledWith({
      pr_number: 42,
      branch: "feature/42-x",
      approved_sha: "abc12340",
      repo_path: REPO_PATH,
      gh_token: "ghs_token",
    });

    // post_auto_merge_cleanup should have been called (cleanup_after_merge is
    // the observable side effect from the mock layer)
    expect(cleanup_after_merge).toHaveBeenCalledWith(REPO_PATH, "feature/42-x");

    // Alert should mention merge
    expect((ctx.alert_router as any).post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: ENTITY_ID,
        tier: "routine",
        title: expect.stringContaining("merged"),
      }),
    );
  });

  it("alerts on ci_regressed — no merge attempted", async () => {
    vi.mocked(run_merge_gate).mockResolvedValueOnce({
      kind: "ci_regressed",
      failures: ["typecheck", "lint"],
    });

    const pr = make_pr();
    const ctx = make_ctx();

    await handle_v2_review_completion(
      ENTITY_ID,
      REPO_PATH,
      REPO_FULL_NAME,
      pr,
      "approved",
      "ghs_token",
      ctx,
    );

    expect(cleanup_after_merge).not.toHaveBeenCalled();
    expect((ctx.alert_router as any).post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: ENTITY_ID,
        tier: "action_required",
        title: expect.stringContaining("CI regressed"),
      }),
    );
  });

  it("handles sha_changed — silent return, no merge", async () => {
    vi.mocked(run_merge_gate).mockResolvedValueOnce({
      kind: "sha_changed",
      observed_sha: "newsha00",
    });

    const pr = make_pr();
    const ctx = make_ctx();

    await handle_v2_review_completion(
      ENTITY_ID,
      REPO_PATH,
      REPO_FULL_NAME,
      pr,
      "approved",
      "ghs_token",
      ctx,
    );

    expect(cleanup_after_merge).not.toHaveBeenCalled();
    // sha_changed is a log, not an alert — alert_router should NOT be called
    expect((ctx.alert_router as any).post_alert).not.toHaveBeenCalled();
  });

  it("alerts on rebase_conflict", async () => {
    vi.mocked(run_merge_gate).mockResolvedValueOnce({
      kind: "rebase_conflict",
      error: "Conflicts in src/main.ts",
    });

    const pr = make_pr();
    const ctx = make_ctx();

    await handle_v2_review_completion(
      ENTITY_ID,
      REPO_PATH,
      REPO_FULL_NAME,
      pr,
      "approved",
      "ghs_token",
      ctx,
    );

    expect(cleanup_after_merge).not.toHaveBeenCalled();
    expect((ctx.alert_router as any).post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: ENTITY_ID,
        tier: "action_required",
        title: expect.stringContaining("Rebase conflict"),
      }),
    );
  });

  it("alerts when no gh_token is available — no merge attempted, no mergeability fetch", async () => {
    const pr = make_pr();
    const ctx = make_ctx();

    await handle_v2_review_completion(
      ENTITY_ID,
      REPO_PATH,
      REPO_FULL_NAME,
      pr,
      "approved",
      undefined, // no token
      ctx,
    );

    // Guard fires before fetch_pr_mergeability — it should never be called
    expect(fetch_pr_mergeability).not.toHaveBeenCalled();
    expect(run_merge_gate).not.toHaveBeenCalled();
    expect(cleanup_after_merge).not.toHaveBeenCalled();
    expect((ctx.alert_router as any).post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: ENTITY_ID,
        tier: "action_required",
        title: expect.stringContaining("No GH token"),
      }),
    );
  });

  it("handles merge_failed outcome — alerts with error", async () => {
    vi.mocked(run_merge_gate).mockResolvedValueOnce({
      kind: "merge_failed",
      error: "422 Unprocessable Entity",
    });

    const pr = make_pr();
    const ctx = make_ctx();

    await handle_v2_review_completion(
      ENTITY_ID,
      REPO_PATH,
      REPO_FULL_NAME,
      pr,
      "approved",
      "ghs_token",
      ctx,
    );

    expect(cleanup_after_merge).not.toHaveBeenCalled();
    expect((ctx.alert_router as any).post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: ENTITY_ID,
        tier: "action_required",
        title: expect.stringContaining("Merge failed"),
      }),
    );
  });

  it("handles branch_protected outcome — alerts", async () => {
    vi.mocked(run_merge_gate).mockResolvedValueOnce({
      kind: "branch_protected",
      merge_state_status: "BLOCKED",
    });

    const pr = make_pr();
    const ctx = make_ctx();

    await handle_v2_review_completion(
      ENTITY_ID,
      REPO_PATH,
      REPO_FULL_NAME,
      pr,
      "approved",
      "ghs_token",
      ctx,
    );

    expect(cleanup_after_merge).not.toHaveBeenCalled();
    expect((ctx.alert_router as any).post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: ENTITY_ID,
        tier: "action_required",
        title: expect.stringContaining("Branch protected"),
      }),
    );
  });

  it("handles rebased_awaiting_ci — logs, no merge", async () => {
    vi.mocked(run_merge_gate).mockResolvedValueOnce({ kind: "rebased_awaiting_ci" });

    const pr = make_pr();
    const ctx = make_ctx();

    await handle_v2_review_completion(
      ENTITY_ID,
      REPO_PATH,
      REPO_FULL_NAME,
      pr,
      "approved",
      "ghs_token",
      ctx,
    );

    expect(cleanup_after_merge).not.toHaveBeenCalled();
    // rebased_awaiting_ci is a log, not an alert
    expect((ctx.alert_router as any).post_alert).not.toHaveBeenCalled();
  });

  it("handles ci_pending — alerts, no merge", async () => {
    vi.mocked(run_merge_gate).mockResolvedValueOnce({ kind: "ci_pending" });

    const pr = make_pr();
    const ctx = make_ctx();

    await handle_v2_review_completion(
      ENTITY_ID,
      REPO_PATH,
      REPO_FULL_NAME,
      pr,
      "approved",
      "ghs_token",
      ctx,
    );

    expect(cleanup_after_merge).not.toHaveBeenCalled();
    // ci_pending alerts because dedup blocks re-dispatch on the same SHA —
    // without a new commit, the PR would be stuck forever
    expect((ctx.alert_router as any).post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: ENTITY_ID,
        tier: "routine",
        title: expect.stringContaining("CI pending"),
      }),
    );
  });

  it("handles mergeable_unknown — logs, waits", async () => {
    vi.mocked(run_merge_gate).mockResolvedValueOnce({ kind: "mergeable_unknown" });

    const pr = make_pr();
    const ctx = make_ctx();

    await handle_v2_review_completion(
      ENTITY_ID,
      REPO_PATH,
      REPO_FULL_NAME,
      pr,
      "approved",
      "ghs_token",
      ctx,
    );

    expect(cleanup_after_merge).not.toHaveBeenCalled();
    expect((ctx.alert_router as any).post_alert).not.toHaveBeenCalled();
  });

  // Note: the "returns early if fetch_pr_mergeability fails" test was removed —
  // the approved path now uses pr.head.sha directly instead of fetching fresh,
  // so there's no API call to fail. The merge-gate handles its own fetch internally.
});

describe("handle_v2_review_completion — pending", () => {
  it("alerts on pending outcome (fallback)", async () => {
    const pr = make_pr();
    const ctx = make_ctx();

    await handle_v2_review_completion(
      ENTITY_ID,
      REPO_PATH,
      REPO_FULL_NAME,
      pr,
      "pending",
      "ghs_token",
      ctx,
    );

    // Should alert but not spawn or merge
    expect((ctx.alert_router as any).post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: ENTITY_ID,
        tier: "routine",
        body: expect.stringContaining("pending"),
      }),
    );
    expect(run_merge_gate).not.toHaveBeenCalled();
    expect((ctx.session_manager as any).spawn).not.toHaveBeenCalled();
  });
});

describe("handle_v2_review_completion — dismissed", () => {
  it("alerts on dismissed — no spawn, no merge", async () => {
    const pr = make_pr();
    const ctx = make_ctx();

    await handle_v2_review_completion(
      ENTITY_ID,
      REPO_PATH,
      REPO_FULL_NAME,
      pr,
      "dismissed",
      "ghs_token",
      ctx,
    );

    // Should alert via alert_router
    expect((ctx.alert_router as any).post_alert).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: ENTITY_ID,
        tier: "routine",
        body: expect.stringContaining("all reviews dismissed"),
      }),
    );

    // Should NOT spawn a builder or run the merge-gate
    expect((ctx.session_manager as any).spawn).not.toHaveBeenCalled();
    expect(run_merge_gate).not.toHaveBeenCalled();
    expect(cleanup_after_merge).not.toHaveBeenCalled();
  });
});
