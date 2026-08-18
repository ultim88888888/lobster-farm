/**
 * Tests for the v2 check-suite handler (#257).
 *
 * The handler is a pure function over its dependency seam — every external
 * call (gh CLI, session spawn, alerts, persistence) is provided through the
 * CheckSuiteDeps interface. Tests stub those deps rather than mocking
 * node:child_process, which keeps the assertions sharp and the tests fast.
 *
 * We build a minimal CheckSuiteContext with a stub registry so the handler
 * can find its entity, and we flip the entity's `pr_lifecycle` flag to
 * exercise the v1/v2 gate.
 */

import {
  type EntityConfig,
  EntityConfigSchema,
  type LobsterFarmConfig,
  LobsterFarmConfigSchema,
} from "@lobster-farm/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CheckSuiteContext,
  type CheckSuiteDeps,
  type CheckSuiteWebhookPayload,
  type PRDetail,
  build_v2_reviewer_prompt,
  handle_check_suite,
} from "../check-suite-handler.js";
import type { PRReviewState, ProcessedPR } from "../persistence.js";
import type { AutoMergeResult } from "../review-utils.js";

// ── Fixtures ──

const SHA_A = "aaaaaaaa00000000000000000000000000000000";
const SHA_B = "bbbbbbbb00000000000000000000000000000000";
const REPO_FULL_NAME = "test-org/test-repo";
const REPO_PATH = "/tmp/test-repo";
const ENTITY_ID = "test-entity";

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({ user: { name: "Test" } });
}

function make_entity(overrides?: { pr_lifecycle?: "v1" | "v2" }): EntityConfig {
  return EntityConfigSchema.parse({
    entity: {
      id: ENTITY_ID,
      name: "Test Entity",
      status: "active",
      pr_lifecycle: overrides?.pr_lifecycle ?? "v2",
      repos: [
        {
          name: "test-repo",
          url: `git@github.com:${REPO_FULL_NAME}.git`,
          path: REPO_PATH,
        },
      ],
      accounts: {},
      channels: { category_id: "cat-1", list: [] },
      memory: { path: "/tmp/memory" },
      secrets: { vault: "1password", vault_name: "test" },
    },
  });
}

function make_pr_detail(overrides: Partial<PRDetail> = {}): PRDetail {
  return {
    number: 42,
    title: "Add new thing",
    branch: "feature/thing",
    base_ref: "main",
    body: "",
    head_sha: SHA_A,
    is_fork: false,
    is_draft: false,
    ...overrides,
  };
}

function make_payload(
  overrides: {
    action?: string;
    conclusion?: CheckSuiteWebhookPayload["check_suite"] extends infer T
      ? T extends { conclusion: infer C }
        ? C
        : never
      : never;
    head_sha?: string;
    pr_number?: number;
    is_fork_repo?: boolean;
    pull_requests?: Array<{ number: number; head_sha: string }>;
    suite_id?: number;
    no_check_suite?: boolean;
    no_repository?: boolean;
    repo_full_name?: string;
  } = {},
): CheckSuiteWebhookPayload {
  const pr_num = overrides.pr_number ?? 42;
  const head_sha = overrides.head_sha ?? SHA_A;
  const pulls = overrides.pull_requests ?? [{ number: pr_num, head_sha }];
  const payload: CheckSuiteWebhookPayload = {
    action: overrides.action ?? "completed",
    repository: overrides.no_repository
      ? undefined
      : {
          full_name: overrides.repo_full_name ?? REPO_FULL_NAME,
          fork: overrides.is_fork_repo ?? false,
        },
    installation: { id: 99 },
  };
  if (!overrides.no_check_suite) {
    payload.check_suite = {
      id: overrides.suite_id ?? 12345,
      head_sha,
      head_branch: "feature/thing",
      conclusion: overrides.conclusion ?? "success",
      pull_requests: pulls.map((p) => ({
        number: p.number,
        head: { ref: "feature/thing", sha: p.head_sha },
        base: { ref: "main" },
      })),
    };
  }
  return payload;
}

interface DepFixtures {
  pr_detail?: PRDetail;
  pr_detail_error?: Error;
  token_error?: Error;
  state?: PRReviewState;
  rerequest_error?: Error;
  spawn_error?: Error;
  ci_failure_logs?: Array<{ check_name: string; log_tail: string; workflow_url: string }>;
  merge_result?: AutoMergeResult;
  merge_error?: Error;
}

interface DepStubs extends CheckSuiteDeps {
  _state: PRReviewState;
}

function make_deps(fixtures: DepFixtures = {}): DepStubs {
  const state: PRReviewState = fixtures.state ?? {};
  const deps: DepStubs = {
    _state: state,
    resolve_token: vi.fn(async () => {
      if (fixtures.token_error) throw fixtures.token_error;
      return "ghs_test_token";
    }),
    fetch_pr_detail: vi.fn(async () => {
      if (fixtures.pr_detail_error) throw fixtures.pr_detail_error;
      return fixtures.pr_detail ?? make_pr_detail();
    }),
    fetch_ci_failure_logs: vi.fn(async () => fixtures.ci_failure_logs ?? []),
    fetch_issue_context: vi.fn(async () => ""),
    load_pr_reviews: vi.fn(async () => ({ ...state })),
    save_pr_reviews: vi.fn(async (next) => {
      // Mutate the shared state object so subsequent loads see the update —
      // mirrors the on-disk behavior where save replaces the file atomically.
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, next);
    }),
    spawn_session: vi.fn(async () => {
      if (fixtures.spawn_error) throw fixtures.spawn_error;
      return { session_id: "sess_123" };
    }),
    notify_alerts: vi.fn(async () => {}),
    rerequest_check_suite: vi.fn(async () => {
      if (fixtures.rerequest_error) throw fixtures.rerequest_error;
    }),
    attempt_merge: vi.fn(async () => {
      if (fixtures.merge_error) throw fixtures.merge_error;
      return fixtures.merge_result ?? { merged: true, method: "direct" as const };
    }),
  };
  return deps;
}

/** Persisted state for a PR the v1 reviewer approved while CI was still running. */
function parked_approved(
  overrides: Partial<ProcessedPR> = {},
  approved_sha: string = SHA_A,
): PRReviewState {
  return {
    [`${ENTITY_ID}:42`]: {
      entity_id: ENTITY_ID,
      pr_number: 42,
      reviewed_at: "2026-08-13T10:00:00Z",
      outcome: "approved",
      v1_approved_sha: approved_sha,
      ...overrides,
    },
  };
}

function make_ctx(entity: EntityConfig = make_entity()): CheckSuiteContext {
  return {
    registry: {
      get_active: () => [entity],
      get: () => entity,
      get_all: () => [entity],
      load_all: vi.fn(),
      count: () => 1,
    } as unknown as CheckSuiteContext["registry"],
    config: make_config(),
    github_app: {} as CheckSuiteContext["github_app"],
    session_manager: {} as CheckSuiteContext["session_manager"],
    discord: null,
  };
}

// ── Silence logs from the handler ──

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ── Tests ──

describe("handle_check_suite — gating", () => {
  it("ignores non-completed actions", async () => {
    const deps = make_deps();
    const ctx = make_ctx();
    const result = await handle_check_suite(make_payload({ action: "requested" }), ctx, deps);
    expect(result).toEqual({ kind: "noop", reason: "wrong_action" });
    expect(deps.spawn_session).not.toHaveBeenCalled();
  });

  it("ignores events with no check_suite payload", async () => {
    const deps = make_deps();
    const ctx = make_ctx();
    const result = await handle_check_suite(make_payload({ no_check_suite: true }), ctx, deps);
    expect(result).toEqual({ kind: "noop", reason: "missing_check_suite" });
  });

  it("ignores events with no repository", async () => {
    const deps = make_deps();
    const ctx = make_ctx();
    const result = await handle_check_suite(make_payload({ no_repository: true }), ctx, deps);
    expect(result.kind).toBe("noop");
    if (result.kind === "noop") expect(result.reason).toBe("no_repository");
  });

  it("ignores repos that don't map to any active entity", async () => {
    const deps = make_deps();
    const ctx = make_ctx();
    const result = await handle_check_suite(
      make_payload({ repo_full_name: "somebody/else" }),
      ctx,
      deps,
    );
    expect(result).toEqual({ kind: "noop", reason: "unknown_repo" });
    expect(deps.resolve_token).not.toHaveBeenCalled();
  });

  it("never spawns a reviewer for entities still on v1 (feature flag gate)", async () => {
    const deps = make_deps();
    const ctx = make_ctx(make_entity({ pr_lifecycle: "v1" }));
    const result = await handle_check_suite(make_payload(), ctx, deps);
    // No persisted approval → the v1 branch has nothing to merge.
    expect(result).toEqual({ kind: "noop", reason: "v1_not_approved" });
    expect(deps.spawn_session).not.toHaveBeenCalled();
    expect(deps.attempt_merge).not.toHaveBeenCalled();
  });

  it("no-ops when check_suite has no associated PRs", async () => {
    const deps = make_deps();
    const ctx = make_ctx();
    const result = await handle_check_suite(make_payload({ pull_requests: [] }), ctx, deps);
    expect(result).toEqual({ kind: "noop", reason: "no_pull_requests" });
  });

  it("skips fork PRs entirely (Decision 3)", async () => {
    const deps = make_deps({ pr_detail: make_pr_detail({ is_fork: true }) });
    const ctx = make_ctx();
    const result = await handle_check_suite(make_payload(), ctx, deps);
    expect(result).toEqual({ kind: "noop", reason: "fork_pr" });
    expect(deps.spawn_session).not.toHaveBeenCalled();
  });

  it("skips draft PRs", async () => {
    const deps = make_deps({ pr_detail: make_pr_detail({ is_draft: true }) });
    const ctx = make_ctx();
    const result = await handle_check_suite(make_payload(), ctx, deps);
    expect(result).toEqual({ kind: "noop", reason: "draft_pr" });
    expect(deps.spawn_session).not.toHaveBeenCalled();
  });

  it("skips PRs targeting non-default base branches", async () => {
    const deps = make_deps({ pr_detail: make_pr_detail({ base_ref: "develop" }) });
    const ctx = make_ctx();
    const result = await handle_check_suite(make_payload(), ctx, deps);
    expect(result).toEqual({ kind: "noop", reason: "non_default_base" });
  });

  it("dedups duplicate check_suite events for the same head SHA", async () => {
    const existing: ProcessedPR = {
      entity_id: ENTITY_ID,
      pr_number: 42,
      reviewed_at: "2026-04-14T10:00:00Z",
      outcome: "pending",
      v2_last_dispatched_sha: SHA_A,
    };
    const deps = make_deps({ state: { [`${ENTITY_ID}:42`]: existing } });
    const ctx = make_ctx();
    const result = await handle_check_suite(make_payload(), ctx, deps);
    expect(result).toEqual({ kind: "noop", reason: "duplicate_sha" });
    expect(deps.spawn_session).not.toHaveBeenCalled();
  });
});

describe("handle_check_suite — success path", () => {
  it("spawns reviewer on conclusion=success", async () => {
    const deps = make_deps();
    const ctx = make_ctx();
    const result = await handle_check_suite(make_payload(), ctx, deps);

    expect(result).toEqual({
      kind: "spawned_reviewer",
      pr_number: 42,
      head_sha: SHA_A,
      with_prior_feedback: false,
    });

    expect(deps.spawn_session).toHaveBeenCalledTimes(1);
    const spawn_call = vi.mocked(deps.spawn_session).mock.calls[0]![0];
    expect(spawn_call.archetype).toBe("reviewer");
    expect(spawn_call.model).toEqual({ model: "sonnet", think: "standard" });
    expect(spawn_call.feature_id).toBe("pr-review-42");
    expect(spawn_call.gh_token).toBe("ghs_test_token");
    expect(spawn_call.prompt).toContain("CI status: GREEN");
    expect(spawn_call.prompt).not.toContain("Previous Review Feedback");
  });

  it("persists v2_last_dispatched_sha BEFORE spawning (dedup race safety)", async () => {
    // Make spawn_session assert that save_pr_reviews has already been called
    // with the updated SHA. If spawn fires before persistence, a duplicate
    // webhook arriving mid-spawn would dispatch again.
    const deps = make_deps();
    const ctx = make_ctx();

    const save_calls: string[] = [];
    const spawn_calls: string[] = [];
    vi.mocked(deps.save_pr_reviews).mockImplementation(async (next) => {
      save_calls.push("save");
      const key = `${ENTITY_ID}:42`;
      const entry = next[key];
      expect(entry?.v2_last_dispatched_sha).toBe(SHA_A);
    });
    vi.mocked(deps.spawn_session).mockImplementation(async () => {
      spawn_calls.push("spawn");
      return { session_id: "sess_123" };
    });

    await handle_check_suite(make_payload(), ctx, deps);

    expect(save_calls).toEqual(["save"]);
    expect(spawn_calls).toEqual(["spawn"]);
    expect(vi.mocked(deps.save_pr_reviews).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.spawn_session).mock.invocationCallOrder[0]!,
    );
  });

  it("passes prior review feedback to reviewer on re-review (Decision 5)", async () => {
    // Builder pushed a new SHA after the reviewer previously requested changes
    // on SHA_A. The fresh check_suite on SHA_B should pass the prior feedback
    // into the reviewer prompt so it can verify the builder addressed it.
    const existing: ProcessedPR = {
      entity_id: ENTITY_ID,
      pr_number: 42,
      reviewed_at: "2026-04-14T09:00:00Z",
      outcome: "changes_requested",
      v2_last_review_feedback: "Please add tests for the edge case in foo().",
      v2_last_review_sha: SHA_A,
    };
    const deps = make_deps({
      state: { [`${ENTITY_ID}:42`]: existing },
      pr_detail: make_pr_detail({ head_sha: SHA_B }),
    });
    const ctx = make_ctx();

    const result = await handle_check_suite(make_payload({ head_sha: SHA_B }), ctx, deps);

    expect(result).toEqual({
      kind: "spawned_reviewer",
      pr_number: 42,
      head_sha: SHA_B,
      with_prior_feedback: true,
    });
    const spawn_call = vi.mocked(deps.spawn_session).mock.calls[0]![0];
    expect(spawn_call.prompt).toContain("Previous Review Feedback");
    expect(spawn_call.prompt).toContain("Please add tests for the edge case");
    expect(spawn_call.prompt).toContain(SHA_A.slice(0, 8));
  });

  it("does NOT resend prior feedback if reviewer is re-running against the same SHA", async () => {
    // Edge case: v2_last_review_sha === current head_sha. This would mean the
    // reviewer is re-running on the exact SHA it just reviewed — don't echo
    // its own feedback back at itself.
    const existing: ProcessedPR = {
      entity_id: ENTITY_ID,
      pr_number: 42,
      reviewed_at: "2026-04-14T09:00:00Z",
      outcome: "changes_requested",
      v2_last_review_feedback: "Old feedback",
      v2_last_review_sha: SHA_A,
      // NOTE: no v2_last_dispatched_sha, so not a dedup hit.
    };
    const deps = make_deps({ state: { [`${ENTITY_ID}:42`]: existing } });
    const ctx = make_ctx();

    const result = await handle_check_suite(make_payload(), ctx, deps);

    expect(result).toMatchObject({
      kind: "spawned_reviewer",
      with_prior_feedback: false,
    });
  });

  it("alerts when spawn_session throws", async () => {
    const deps = make_deps({ spawn_error: new Error("session spawn failed") });
    const ctx = make_ctx();
    const result = await handle_check_suite(make_payload(), ctx, deps);

    expect(result).toEqual({
      kind: "alerted",
      pr_number: 42,
      reason: "spawn_failed",
    });
    expect(deps.notify_alerts).toHaveBeenCalledWith(
      ENTITY_ID,
      expect.stringContaining("Failed to spawn reviewer"),
    );
  });
});

describe("handle_check_suite — failure path (Decision 4: flake retry)", () => {
  it("first failure on a SHA → rerequests check_suite (flake retry)", async () => {
    const deps = make_deps();
    const ctx = make_ctx();
    const result = await handle_check_suite(
      make_payload({ conclusion: "failure", suite_id: 9999 }),
      ctx,
      deps,
    );

    expect(result).toEqual({
      kind: "rerequested",
      check_suite_id: 9999,
      pr_number: 42,
    });
    expect(deps.rerequest_check_suite).toHaveBeenCalledWith(REPO_FULL_NAME, 9999, "ghs_test_token");
    expect(deps.spawn_session).not.toHaveBeenCalled();

    // Persistence should record the retry count for this SHA
    const saved = deps._state[`${ENTITY_ID}:42`];
    expect(saved?.v2_flake_retries).toBe(1);
    expect(saved?.v2_flake_retry_sha).toBe(SHA_A);
    // v2_last_dispatched_sha must NOT be set — the rerequested suite runs on
    // the same SHA, so setting the dedup key here would permanently block the
    // ci-fixer from ever spawning on the follow-up failure.
    expect(saved?.v2_last_dispatched_sha).toBeUndefined();
  });

  it("second failure on the SAME SHA → spawns ci-fixer (no more retries)", async () => {
    const existing: ProcessedPR = {
      entity_id: ENTITY_ID,
      pr_number: 42,
      reviewed_at: "2026-04-14T09:00:00Z",
      outcome: "pending",
      v2_flake_retries: 1,
      v2_flake_retry_sha: SHA_A,
    };
    const deps = make_deps({
      state: { [`${ENTITY_ID}:42`]: existing },
      ci_failure_logs: [
        { check_name: "typecheck", log_tail: "error TS2322", workflow_url: "http://x" },
      ],
    });
    const ctx = make_ctx();

    const result = await handle_check_suite(make_payload({ conclusion: "failure" }), ctx, deps);

    expect(result).toMatchObject({
      kind: "spawned_ci_fixer",
      pr_number: 42,
      attempt: 1,
    });
    expect(deps.rerequest_check_suite).not.toHaveBeenCalled();
    expect(deps.spawn_session).toHaveBeenCalledTimes(1);

    const spawn_call = vi.mocked(deps.spawn_session).mock.calls[0]![0];
    expect(spawn_call.archetype).toBe("builder");
    expect(spawn_call.model).toEqual({ model: "opus", think: "high" });
    expect(spawn_call.feature_id).toBe("ci-fix-42");
  });

  it("resets flake retry counter when SHA changes", async () => {
    // Previously we retried flake on SHA_A. Now a new SHA (SHA_B) just failed
    // for the first time — it should get its own retry budget.
    const existing: ProcessedPR = {
      entity_id: ENTITY_ID,
      pr_number: 42,
      reviewed_at: "2026-04-14T09:00:00Z",
      outcome: "pending",
      v2_flake_retries: 1,
      v2_flake_retry_sha: SHA_A,
    };
    const deps = make_deps({
      state: { [`${ENTITY_ID}:42`]: existing },
      pr_detail: make_pr_detail({ head_sha: SHA_B }),
    });
    const ctx = make_ctx();

    const result = await handle_check_suite(
      make_payload({ conclusion: "failure", head_sha: SHA_B }),
      ctx,
      deps,
    );

    expect(result.kind).toBe("rerequested");
    expect(deps.rerequest_check_suite).toHaveBeenCalled();

    const saved = deps._state[`${ENTITY_ID}:42`];
    expect(saved?.v2_flake_retry_sha).toBe(SHA_B);
    expect(saved?.v2_flake_retries).toBe(1);
  });

  it("falls through to ci-fixer if the rerequest API call fails", async () => {
    const deps = make_deps({
      rerequest_error: new Error("403 forbidden"),
      ci_failure_logs: [],
    });
    const ctx = make_ctx();

    const result = await handle_check_suite(make_payload({ conclusion: "failure" }), ctx, deps);

    expect(result.kind).toBe("spawned_ci_fixer");
    expect(deps.spawn_session).toHaveBeenCalledTimes(1);
  });

  it("escalates to #alerts when ci_fix_attempts >= MAX_CI_FIX_ATTEMPTS", async () => {
    const existing: ProcessedPR = {
      entity_id: ENTITY_ID,
      pr_number: 42,
      reviewed_at: "2026-04-14T09:00:00Z",
      outcome: "pending",
      v2_flake_retries: 1,
      v2_flake_retry_sha: SHA_A,
      ci_fix_attempts: 3, // MAX_CI_FIX_ATTEMPTS
    };
    const deps = make_deps({ state: { [`${ENTITY_ID}:42`]: existing } });
    const ctx = make_ctx();

    const result = await handle_check_suite(make_payload({ conclusion: "failure" }), ctx, deps);

    expect(result).toMatchObject({
      kind: "ci_fix_exhausted",
      pr_number: 42,
      attempts: 3,
    });
    expect(deps.spawn_session).not.toHaveBeenCalled();
    expect(deps.notify_alerts).toHaveBeenCalledWith(
      ENTITY_ID,
      expect.stringContaining("CI fix failed after"),
    );
  });

  it("notifies alerts channel when spawning the ci-fixer", async () => {
    const existing: ProcessedPR = {
      entity_id: ENTITY_ID,
      pr_number: 42,
      reviewed_at: "2026-04-14T09:00:00Z",
      outcome: "pending",
      v2_flake_retries: 1,
      v2_flake_retry_sha: SHA_A,
    };
    const deps = make_deps({
      state: { [`${ENTITY_ID}:42`]: existing },
      ci_failure_logs: [{ check_name: "lint", log_tail: "error", workflow_url: "http://x" }],
    });
    const ctx = make_ctx();

    await handle_check_suite(make_payload({ conclusion: "failure" }), ctx, deps);

    expect(deps.notify_alerts).toHaveBeenCalledWith(
      ENTITY_ID,
      expect.stringContaining("spawning builder to fix"),
    );
  });
});

describe("handle_check_suite — cancelled / other conclusions", () => {
  it("alerts on conclusion=cancelled (manual triage needed)", async () => {
    const deps = make_deps();
    const ctx = make_ctx();
    const result = await handle_check_suite(make_payload({ conclusion: "cancelled" }), ctx, deps);

    expect(result).toEqual({
      kind: "alerted",
      pr_number: 42,
      reason: "cancelled",
    });
    expect(deps.spawn_session).not.toHaveBeenCalled();
    expect(deps.notify_alerts).toHaveBeenCalledWith(
      ENTITY_ID,
      expect.stringContaining("cancelled"),
    );
  });

  it("alerts on conclusion=timed_out", async () => {
    const deps = make_deps();
    const ctx = make_ctx();
    const result = await handle_check_suite(make_payload({ conclusion: "timed_out" }), ctx, deps);

    expect(result.kind).toBe("alerted");
    if (result.kind === "alerted") expect(result.reason).toBe("timed_out");
  });

  it("alerts on conclusion=action_required", async () => {
    const deps = make_deps();
    const ctx = make_ctx();
    const result = await handle_check_suite(
      make_payload({ conclusion: "action_required" }),
      ctx,
      deps,
    );

    expect(result).toEqual({
      kind: "alerted",
      pr_number: 42,
      reason: "action_required",
    });
    expect(deps.spawn_session).not.toHaveBeenCalled();
    expect(deps.notify_alerts).toHaveBeenCalledWith(
      ENTITY_ID,
      expect.stringContaining("action_required"),
    );
  });

  it("cancelled does NOT stamp v2_last_dispatched_sha — re-queued CI on same SHA dispatches", async () => {
    // This is the blocking fix: cancelled/timed_out/action_required must not
    // set the dedup key, so a user can re-queue CI on the same SHA and the
    // handler will dispatch on the fresh check_suite event.
    const deps = make_deps();
    const ctx = make_ctx();

    // Step 1: cancelled check_suite
    const result1 = await handle_check_suite(make_payload({ conclusion: "cancelled" }), ctx, deps);
    expect(result1.kind).toBe("alerted");

    // Verify state was persisted WITHOUT v2_last_dispatched_sha
    const saved = vi.mocked(deps.save_pr_reviews).mock.calls[0]?.[0];
    const state_entry = saved?.[`${ENTITY_ID}:42`];
    expect(state_entry).toBeDefined();
    expect(state_entry?.v2_last_dispatched_sha).toBeUndefined();

    // Step 2: user re-queues CI, same SHA fires check_suite.completed=success
    // The handler should NOT dedup — it should dispatch the reviewer.
    const result2 = await handle_check_suite(make_payload({ conclusion: "success" }), ctx, deps);
    expect(result2.kind).toBe("spawned_reviewer");
    expect(deps.spawn_session).toHaveBeenCalledTimes(1);
  });

  it("timed_out does NOT stamp v2_last_dispatched_sha", async () => {
    const deps = make_deps();
    const ctx = make_ctx();

    await handle_check_suite(make_payload({ conclusion: "timed_out" }), ctx, deps);

    const saved = vi.mocked(deps.save_pr_reviews).mock.calls[0]?.[0];
    const state_entry = saved?.[`${ENTITY_ID}:42`];
    expect(state_entry?.v2_last_dispatched_sha).toBeUndefined();
  });

  it("no-ops on conclusion=neutral / stale / skipped", async () => {
    const deps = make_deps();
    const ctx = make_ctx();

    for (const conclusion of ["neutral", "stale", "skipped"] as const) {
      vi.mocked(deps.spawn_session).mockClear();
      const result = await handle_check_suite(make_payload({ conclusion }), ctx, deps);
      expect(result).toEqual({ kind: "noop", reason: "unhandled_conclusion" });
      expect(deps.spawn_session).not.toHaveBeenCalled();
    }
  });
});

describe("handle_check_suite — resilience", () => {
  it("alerts if token resolution fails", async () => {
    const deps = make_deps({ token_error: new Error("app auth failed") });
    const ctx = make_ctx();
    const result = await handle_check_suite(make_payload(), ctx, deps);

    expect(result).toEqual({
      kind: "alerted",
      pr_number: 42,
      reason: "token_failed",
    });
    expect(deps.notify_alerts).toHaveBeenCalled();
    expect(deps.spawn_session).not.toHaveBeenCalled();
  });

  it("no-ops with pr_fetch_failed if gh pr view fails", async () => {
    const deps = make_deps({ pr_detail_error: new Error("pr not found") });
    const ctx = make_ctx();
    const result = await handle_check_suite(make_payload(), ctx, deps);

    expect(result).toEqual({ kind: "noop", reason: "pr_fetch_failed" });
    expect(deps.spawn_session).not.toHaveBeenCalled();
  });
});

// ── v1 merge re-entry (#355) ──

/**
 * v1 entities never had a CI-completion trigger: the only merge path was
 * `pull_request.opened/synchronize`. Now that the v1 approved path parks a PR
 * whose CI is still running (instead of merging past it), `check_suite.completed`
 * is what wakes it back up.
 *
 * The branch is deliberately narrow — it merges or it does nothing. It must
 * never spawn a reviewer, a ci-fixer, or a flake rerun.
 */
describe("handle_check_suite — v1 merge re-entry (#355)", () => {
  const v1_ctx = () => make_ctx(make_entity({ pr_lifecycle: "v1" }));

  it("merges an approved-and-parked PR when CI completes green", async () => {
    const deps = make_deps({ state: parked_approved() });
    const result = await handle_check_suite(make_payload(), v1_ctx(), deps);

    expect(result).toEqual({
      kind: "merged",
      pr_number: 42,
      head_sha: SHA_A,
      method: "direct",
    });
    expect(deps.attempt_merge).toHaveBeenCalledWith(
      42,
      "feature/thing",
      REPO_PATH,
      "ghs_test_token",
    );
    // Merge or nothing — no reviewer, no ci-fixer, no flake rerun.
    expect(deps.spawn_session).not.toHaveBeenCalled();
    expect(deps.rerequest_check_suite).not.toHaveBeenCalled();
  });

  it("merges at most once for repeated completed events on the same SHA", async () => {
    const deps = make_deps({ state: parked_approved() });
    const ctx = v1_ctx();

    const first = await handle_check_suite(make_payload(), ctx, deps);
    const second = await handle_check_suite(make_payload(), ctx, deps);

    expect(first.kind).toBe("merged");
    expect(second).toEqual({ kind: "noop", reason: "duplicate_sha" });
    expect(deps.attempt_merge).toHaveBeenCalledTimes(1);
  });

  it("uses a v1-specific dedup key, not the v2 one", async () => {
    const deps = make_deps({ state: parked_approved() });
    await handle_check_suite(make_payload(), v1_ctx(), deps);

    const saved = vi.mocked(deps.save_pr_reviews).mock.calls[0]?.[0];
    const entry = saved?.[`${ENTITY_ID}:42`];
    expect(entry?.v1_merge_attempted_sha).toBe(SHA_A);
    expect(entry?.v2_last_dispatched_sha).toBeUndefined();
  });

  it("persists the dedup key BEFORE attempting the merge", async () => {
    const deps = make_deps({ state: parked_approved() });
    const order: string[] = [];
    vi.mocked(deps.save_pr_reviews).mockImplementation(async () => {
      order.push("save");
    });
    vi.mocked(deps.attempt_merge).mockImplementation(async () => {
      order.push("merge");
      return { merged: true, method: "direct" };
    });

    await handle_check_suite(make_payload(), v1_ctx(), deps);
    expect(order).toEqual(["save", "merge"]);
  });

  it("ignores a v1 PR with no persisted review state", async () => {
    const deps = make_deps();
    const result = await handle_check_suite(make_payload(), v1_ctx(), deps);

    expect(result).toEqual({ kind: "noop", reason: "v1_not_approved" });
    expect(deps.attempt_merge).not.toHaveBeenCalled();
    // Cheap local state check comes first — no GitHub round-trips for the
    // overwhelming majority of v1 check_suite events.
    expect(deps.resolve_token).not.toHaveBeenCalled();
    expect(deps.fetch_pr_detail).not.toHaveBeenCalled();
  });

  it("ignores a v1 PR whose last outcome was changes_requested", async () => {
    const deps = make_deps({ state: parked_approved({ outcome: "changes_requested" }) });
    const result = await handle_check_suite(make_payload(), v1_ctx(), deps);

    expect(result).toEqual({ kind: "noop", reason: "v1_not_approved" });
    expect(deps.attempt_merge).not.toHaveBeenCalled();
  });

  it("ignores a stale approval pinned to a different SHA", async () => {
    // The v1 CI fix loop seeds entries with outcome=approved. Without the SHA
    // pin, a green check_suite on the builder's new commit would merge code no
    // reviewer has seen.
    const deps = make_deps({
      state: parked_approved({ ci_fix_attempts: 1 }, SHA_B),
    });
    const result = await handle_check_suite(make_payload({ head_sha: SHA_A }), v1_ctx(), deps);

    expect(result).toEqual({ kind: "noop", reason: "v1_not_approved" });
    expect(deps.attempt_merge).not.toHaveBeenCalled();
  });

  it("does not merge when the PR head moved past the completed suite", async () => {
    const deps = make_deps({
      state: parked_approved(),
      pr_detail: make_pr_detail({ head_sha: SHA_B }),
    });
    const result = await handle_check_suite(make_payload({ head_sha: SHA_A }), v1_ctx(), deps);

    expect(result).toEqual({ kind: "noop", reason: "v1_sha_moved" });
    expect(deps.attempt_merge).not.toHaveBeenCalled();
  });

  it("does not merge a PR that went back to draft", async () => {
    const deps = make_deps({
      state: parked_approved(),
      pr_detail: make_pr_detail({ is_draft: true }),
    });
    const result = await handle_check_suite(make_payload(), v1_ctx(), deps);

    expect(result).toEqual({ kind: "noop", reason: "draft_pr" });
    expect(deps.attempt_merge).not.toHaveBeenCalled();
  });

  it("ignores non-completed actions", async () => {
    const deps = make_deps({ state: parked_approved() });
    const result = await handle_check_suite(make_payload({ action: "requested" }), v1_ctx(), deps);

    expect(result).toEqual({ kind: "noop", reason: "wrong_action" });
    expect(deps.attempt_merge).not.toHaveBeenCalled();
  });

  for (const conclusion of ["failure", "timed_out", "cancelled"] as const) {
    it(`does not merge on conclusion=${conclusion} and alerts once`, async () => {
      const deps = make_deps({ state: parked_approved() });
      const ctx = v1_ctx();

      const first = await handle_check_suite(make_payload({ conclusion }), ctx, deps);
      const second = await handle_check_suite(make_payload({ conclusion }), ctx, deps);

      expect(first).toEqual({ kind: "alerted", pr_number: 42, reason: conclusion });
      expect(second.kind).toBe("noop");
      expect(deps.notify_alerts).toHaveBeenCalledTimes(1);
      expect(deps.attempt_merge).not.toHaveBeenCalled();
      // v1 keeps its existing fix loop — this branch must not duplicate it.
      expect(deps.spawn_session).not.toHaveBeenCalled();
      expect(deps.rerequest_check_suite).not.toHaveBeenCalled();
    });
  }

  it("re-alerts when CI fails again on a new SHA", async () => {
    const deps = make_deps({ state: parked_approved() });
    const ctx = v1_ctx();

    await handle_check_suite(make_payload({ conclusion: "failure" }), ctx, deps);
    // A new push re-parks the PR at SHA_B (webhook-handler's job); simulate it.
    deps._state[`${ENTITY_ID}:42`] = {
      ...deps._state[`${ENTITY_ID}:42`]!,
      v1_approved_sha: SHA_B,
    };
    const second = await handle_check_suite(
      make_payload({ conclusion: "failure", head_sha: SHA_B }),
      ctx,
      deps,
    );

    expect(second).toEqual({ kind: "alerted", pr_number: 42, reason: "failure" });
    expect(deps.notify_alerts).toHaveBeenCalledTimes(2);
  });

  it("no-ops on non-actionable conclusions", async () => {
    for (const conclusion of ["neutral", "stale", "skipped", "action_required"] as const) {
      const deps = make_deps({ state: parked_approved() });
      const result = await handle_check_suite(make_payload({ conclusion }), v1_ctx(), deps);

      expect(result).toEqual({ kind: "noop", reason: "unhandled_conclusion" });
      expect(deps.attempt_merge).not.toHaveBeenCalled();
      expect(deps.notify_alerts).not.toHaveBeenCalled();
    }
  });

  it("alerts when the merge attempt is rejected", async () => {
    const deps = make_deps({
      state: parked_approved(),
      merge_result: { merged: false, failure: "CONFLICT", error: "rebase conflicts" },
    });
    const result = await handle_check_suite(make_payload(), v1_ctx(), deps);

    expect(result).toEqual({ kind: "alerted", pr_number: 42, reason: "merge_failed" });
    expect(vi.mocked(deps.notify_alerts).mock.calls[0]?.[1]).toContain("rebase conflicts");
  });

  it("alerts when the merge attempt throws", async () => {
    const deps = make_deps({
      state: parked_approved(),
      merge_error: new Error("gh exploded"),
    });
    const result = await handle_check_suite(make_payload(), v1_ctx(), deps);

    expect(result).toEqual({ kind: "alerted", pr_number: 42, reason: "merge_failed" });
    expect(vi.mocked(deps.notify_alerts).mock.calls[0]?.[1]).toContain("gh exploded");
  });

  it("alerts if token resolution fails on the merge path", async () => {
    const deps = make_deps({ state: parked_approved(), token_error: new Error("app auth failed") });
    const result = await handle_check_suite(make_payload(), v1_ctx(), deps);

    expect(result).toEqual({ kind: "alerted", pr_number: 42, reason: "token_failed" });
    expect(deps.attempt_merge).not.toHaveBeenCalled();
  });

  it("no-ops when the PR detail fetch fails", async () => {
    const deps = make_deps({
      state: parked_approved(),
      pr_detail_error: new Error("pr not found"),
    });
    const result = await handle_check_suite(make_payload(), v1_ctx(), deps);

    expect(result).toEqual({ kind: "noop", reason: "pr_fetch_failed" });
    expect(deps.attempt_merge).not.toHaveBeenCalled();
  });

  it("no-ops when the check suite has no associated PRs", async () => {
    const deps = make_deps({ state: parked_approved() });
    const result = await handle_check_suite(make_payload({ pull_requests: [] }), v1_ctx(), deps);

    expect(result).toEqual({ kind: "noop", reason: "no_pull_requests" });
    expect(deps.attempt_merge).not.toHaveBeenCalled();
  });

  it("leaves v2 entities on the reviewer path even with parked-approved state", async () => {
    const deps = make_deps({ state: parked_approved() });
    const result = await handle_check_suite(make_payload(), make_ctx(), deps);

    expect(result.kind).toBe("spawned_reviewer");
    expect(deps.attempt_merge).not.toHaveBeenCalled();
  });
});

// ── Prompt builder unit tests ──

describe("build_v2_reviewer_prompt", () => {
  const pr = make_pr_detail();

  it("includes head SHA and CI-green assurance", () => {
    const prompt = build_v2_reviewer_prompt(pr, REPO_PATH, "");
    expect(prompt).toContain(`Head SHA: ${SHA_A}`);
    expect(prompt).toContain("CI status: GREEN");
    expect(prompt).toContain("Do NOT run `gh pr checks`");
    expect(prompt).toContain("Do NOT run `gh pr merge`");
  });

  it("includes PR header with number for dynamic context", () => {
    const prompt = build_v2_reviewer_prompt(pr, REPO_PATH, "");
    // gh pr review command templates now live in the agent's initialPrompt
    // frontmatter — the dynamic prefix only needs to identify which PR.
    expect(prompt).toContain("PR #42");
  });

  it("includes prior feedback section when provided (Decision 5)", () => {
    const prompt = build_v2_reviewer_prompt(pr, REPO_PATH, "", {
      body: "Add tests for the null branch",
      since_sha: SHA_B,
    });
    expect(prompt).toContain("## Previous Review Feedback");
    expect(prompt).toContain("Add tests for the null branch");
    expect(prompt).toContain(SHA_B.slice(0, 8));
    expect(prompt).toContain("Verify each item above was actually addressed");
  });

  it("omits prior feedback section when not provided", () => {
    const prompt = build_v2_reviewer_prompt(pr, REPO_PATH, "");
    expect(prompt).not.toContain("Previous Review Feedback");
  });

  it("includes linked issue context when provided", () => {
    const prompt = build_v2_reviewer_prompt(pr, REPO_PATH, "Issue #123: do the thing");
    expect(prompt).toContain("## Linked Issue Context");
    expect(prompt).toContain("Issue #123: do the thing");
  });
});
