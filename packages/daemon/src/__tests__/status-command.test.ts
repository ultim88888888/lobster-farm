import { describe, it, expect } from "vitest";
import {
  format_duration,
  format_uptime,
  format_cross_entity_dashboard,
  type DashboardData,
} from "../discord.js";

// ── format_duration ──

describe("format_duration", () => {
  it("formats hours and minutes", () => {
    const start = new Date(Date.now() - 2 * 60 * 60_000 - 14 * 60_000);
    expect(format_duration(start)).toBe("2h 14m");
  });

  it("formats minutes only when under an hour", () => {
    const start = new Date(Date.now() - 45 * 60_000);
    expect(format_duration(start)).toBe("45m");
  });

  it("formats zero minutes for very recent start", () => {
    const start = new Date(Date.now() - 10_000); // 10 seconds ago
    expect(format_duration(start)).toBe("0m");
  });

  it("formats exactly one hour", () => {
    const start = new Date(Date.now() - 60 * 60_000);
    expect(format_duration(start)).toBe("1h 0m");
  });

  it("handles future dates gracefully", () => {
    const start = new Date(Date.now() + 60_000);
    expect(format_duration(start)).toBe("0m");
  });

  it("formats large durations", () => {
    const start = new Date(Date.now() - 25 * 60 * 60_000 - 30 * 60_000);
    expect(format_duration(start)).toBe("25h 30m");
  });
});

// ── format_uptime ──

describe("format_uptime", () => {
  it("formats seconds into hours and minutes", () => {
    expect(format_uptime(4 * 3600 + 22 * 60)).toBe("4h 22m");
  });

  it("formats sub-hour durations as minutes only", () => {
    expect(format_uptime(45 * 60)).toBe("45m");
  });

  it("handles zero seconds", () => {
    expect(format_uptime(0)).toBe("0m");
  });

  it("handles negative seconds gracefully", () => {
    expect(format_uptime(-100)).toBe("0m");
  });

  it("formats exactly one hour", () => {
    expect(format_uptime(3600)).toBe("1h 0m");
  });

  it("truncates partial minutes", () => {
    // 90.5 seconds = 1 minute (floor)
    expect(format_uptime(90.5)).toBe("1m");
  });
});

// ── format_cross_entity_dashboard ──

describe("format_cross_entity_dashboard", () => {
  function make_data(overrides: Partial<DashboardData> = {}): DashboardData {
    return {
      uptime: "4h 22m",
      pool_assigned: 3,
      pool_total: 10,
      entities: [],
      ...overrides,
    };
  }

  it("shows daemon and pool summary header", () => {
    const result = format_cross_entity_dashboard(make_data());
    expect(result).toContain("**LobsterFarm Status**");
    expect(result).toContain("**Daemon:** running (uptime: 4h 22m)");
    expect(result).toContain("**Pool:** 3/10 assigned, 7 free");
  });

  it("shows active sessions grouped by entity", () => {
    const result = format_cross_entity_dashboard(make_data({
      entities: [
        {
          id: "lobster-farm",
          sessions: [
            { channel_name: "#general", agent_label: "Gary (planner)", duration: "2h 14m" },
            { channel_name: "#work-room-1", agent_label: "Bob (builder)", duration: "12m" },
          ],
        },
        {
          id: "my-client",
          sessions: [],
        },
      ],
    }));

    expect(result).toContain("--- lobster-farm ---");
    expect(result).toContain("Sessions:");
    expect(result).toContain("  \u2022 #general \u2014 Gary (planner) \u2014 2h 14m");
    expect(result).toContain("  \u2022 #work-room-1 \u2014 Bob (builder) \u2014 12m");
    expect(result).toContain("--- my-client ---");
    expect(result).toContain("No active work.");
  });

  it("shows 'No active work.' for entities with no sessions", () => {
    const result = format_cross_entity_dashboard(make_data({
      entities: [
        { id: "idle-project", sessions: [] },
        { id: "another-idle", sessions: [] },
      ],
    }));

    expect(result).toContain("--- idle-project ---\nNo active work.");
    expect(result).toContain("--- another-idle ---\nNo active work.");
  });

  it("handles empty entity list", () => {
    const result = format_cross_entity_dashboard(make_data({ entities: [] }));
    expect(result).toContain("**LobsterFarm Status**");
    expect(result).toContain("**Pool:**");
    // No entity sections
    expect(result).not.toContain("---");
  });

  it("truncates when response would exceed 2000 characters", () => {
    // Create many entities to blow past the limit
    const entities = Array.from({ length: 50 }, (_, i) => ({
      id: `entity-with-a-long-name-${String(i).padStart(3, "0")}`,
      sessions: [
        {
          channel_name: `#work-room-${String(i)}`,
          agent_label: "Gary (planner)",
          duration: "1h 30m",
        },
      ],
    }));

    const result = format_cross_entity_dashboard(make_data({
      pool_assigned: 50,
      pool_total: 50,
      entities,
    }));

    expect(result.length).toBeLessThanOrEqual(2000);
    expect(result).toContain("\u2026 and ");
    expect(result).toContain("more entities");
  });

  it("does not truncate when response fits within limit", () => {
    const result = format_cross_entity_dashboard(make_data({
      entities: [
        { id: "small", sessions: [] },
      ],
    }));

    expect(result).not.toContain("\u2026 and ");
    expect(result).toContain("--- small ---");
  });

  it("computes pool free count correctly", () => {
    const result = format_cross_entity_dashboard(make_data({
      pool_assigned: 0,
      pool_total: 10,
    }));
    expect(result).toContain("**Pool:** 0/10 assigned, 10 free");
  });

  it("handles all bots assigned", () => {
    const result = format_cross_entity_dashboard(make_data({
      pool_assigned: 10,
      pool_total: 10,
    }));
    expect(result).toContain("**Pool:** 10/10 assigned, 0 free");
  });
});
