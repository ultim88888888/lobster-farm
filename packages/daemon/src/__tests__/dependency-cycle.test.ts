import { describe, expect, it } from "vitest";
import type { FeatureState } from "@lobster-farm/shared";
import { check_dependency_cycle } from "../features.js";

// Minimal feature stub — only the fields cycle detection cares about.
function stub(id: string, dependsOn: string[] = []): FeatureState {
  return {
    id,
    entity: "test",
    githubIssue: 0,
    title: "",
    phase: "plan",
    priority: "medium",
    branch: "",
    worktreePath: null,
    discordWorkRoom: null,
    activeArchetype: null,
    activeDna: [],
    sessionId: null,
    lastSessionId: null,
    lastBuilderSessionId: null,
    dependsOn,
    blocked: false,
    blockedReason: null,
    approved: false,
    labels: [],
    prNumber: null,
    agentDone: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("check_dependency_cycle", () => {
  it("returns null for no cycle (simple chain)", () => {
    // A → B → C, adding D → [C] — no cycle
    const features = new Map<string, FeatureState>();
    features.set("A", stub("A", ["B"]));
    features.set("B", stub("B", ["C"]));
    features.set("C", stub("C"));

    const result = check_dependency_cycle("D", ["C"], features);
    expect(result).toBeNull();
  });

  it("detects direct cycle (A → B → A)", () => {
    const features = new Map<string, FeatureState>();
    features.set("A", stub("A", ["B"]));
    features.set("B", stub("B")); // B has no deps yet

    // Now B depends on A — creating A → B → A
    // We're checking: adding "new" with id=B, depends_on=["A"]
    // Actually let's be precise: B already exists and depends on nothing.
    // We want to check if creating a new feature "C" with depends_on ["A"]
    // where A already depends on... let's test real cycle:

    // A depends on B. Now we create "B-new" but that won't match.
    // Let me re-think: the function checks if adding new_feature_id with deps would create a cycle.

    // Scenario: A exists with dependsOn: ["B"]. B exists with no deps.
    // Now we want B to depend on A. But B already exists, so we'd update it.
    // The function is designed for creation, not updates.

    // Correct test: A exists with dependsOn: []. We create B with depends_on: ["A"].
    // Then we create C with depends_on: ["B"]. This is fine — no cycle.
    // But if A depends on C, and we try to create C depending on B depending on A,
    // creating C with depends_on: [B] would create cycle: C → B → A → C.

    const features2 = new Map<string, FeatureState>();
    features2.set("A", stub("A", ["C"])); // A depends on C (which doesn't exist yet)
    features2.set("B", stub("B", ["A"])); // B depends on A

    // Creating C with depends_on: ["B"] would create: C → B → A → C
    const result = check_dependency_cycle("C", ["B"], features2);
    expect(result).not.toBeNull();
    expect(result).toEqual(["C", "B", "A", "C"]);
  });

  it("detects self-referential dependency", () => {
    // Feature tries to depend on itself
    const features = new Map<string, FeatureState>();
    features.set("X", stub("X")); // X exists

    // Creating Y with depends_on: ["X"] — but wait, self-ref means Y depends on Y.
    // But Y doesn't exist yet. The cycle check looks for new_feature_id in the chain.
    // Self-ref: creating "X-new" that depends on something that transitively depends on "X-new".
    // Actually, self-dependency would be depends_on: ["X-new"] where X-new is the feature being created.
    // But that would fail validation first (X-new doesn't exist yet).
    // The cycle detection only runs after existence validation, so this case
    // is actually caught by the "not found" check, not cycle detection.
    // Still, let's verify the cycle detector itself handles it:

    // If somehow A depends on A (through the graph)
    const features2 = new Map<string, FeatureState>();
    features2.set("A", stub("A", ["NEW"])); // A depends on NEW

    const result = check_dependency_cycle("NEW", ["A"], features2);
    expect(result).not.toBeNull();
    expect(result).toEqual(["NEW", "A", "NEW"]);
  });

  it("returns null for empty depends_on", () => {
    const features = new Map<string, FeatureState>();
    features.set("A", stub("A"));

    const result = check_dependency_cycle("B", [], features);
    expect(result).toBeNull();
  });

  it("returns null when dependency has no further deps", () => {
    const features = new Map<string, FeatureState>();
    features.set("A", stub("A"));

    const result = check_dependency_cycle("B", ["A"], features);
    expect(result).toBeNull();
  });

  it("detects cycle in diamond dependency graph", () => {
    //     X
    //    / \
    //   A   B
    //    \ /
    //     C → X  (cycle!)
    const features = new Map<string, FeatureState>();
    features.set("A", stub("A", ["C"]));
    features.set("B", stub("B", ["C"]));
    features.set("C", stub("C", ["X"])); // C depends on X

    // Creating X with depends_on: [A, B]
    // X → A → C → X — cycle through A
    const result = check_dependency_cycle("X", ["A", "B"], features);
    expect(result).not.toBeNull();
    // Should detect via path X → A → C → X
    expect(result![0]).toBe("X");
    expect(result![result!.length - 1]).toBe("X");
  });

  it("handles deep chains without cycles", () => {
    const features = new Map<string, FeatureState>();
    features.set("A", stub("A", ["B"]));
    features.set("B", stub("B", ["C"]));
    features.set("C", stub("C", ["D"]));
    features.set("D", stub("D", ["E"]));
    features.set("E", stub("E"));

    // Creating F that depends on A — long chain but no cycle
    const result = check_dependency_cycle("F", ["A"], features);
    expect(result).toBeNull();
  });

  it("handles multiple dependencies, one creating a cycle", () => {
    const features = new Map<string, FeatureState>();
    features.set("A", stub("A"));
    features.set("B", stub("B", ["NEW"])); // B depends on NEW

    // Creating NEW with depends_on: [A, B]
    // A is fine, but B → NEW creates cycle
    const result = check_dependency_cycle("NEW", ["A", "B"], features);
    expect(result).not.toBeNull();
    expect(result).toEqual(["NEW", "B", "NEW"]);
  });
});
