import { describe, expect, it } from "vitest";
import { composer_region, is_pane_idle } from "../tui-pane.js";
import {
  PANE_IDLE_HINT_OWN_ROW,
  PANE_IDLE_HINT_SAME_ROW,
  PANE_IDLE_WITH_AGENT_FOOTER,
  PANE_IDLE_WITH_TAB_ROW,
  PANE_WORKING,
} from "./helpers/idle-pane-fixtures.js";

/** Every fixture is a real capture; assert the properties the tests below lean
 * on, so a future re-capture that loses them fails loudly here rather than
 * quietly weakening the suite. */
describe("fixtures are real captures", () => {
  it("puts the /rc hint on its own row for the long-idle panes", () => {
    for (const pane of [PANE_IDLE_HINT_OWN_ROW, PANE_IDLE_WITH_TAB_ROW, PANE_WORKING]) {
      const lines = pane.trimEnd().split("\n");
      expect(lines.some((l) => l.trim() === "/rc")).toBe(true);
    }
  });

  it("puts the /rc hint on the status bar row for the recently-active pane", () => {
    const lines = PANE_IDLE_HINT_SAME_ROW.trimEnd().split("\n");
    expect(lines.some((l) => l.includes("bypass permissions") && l.includes("/rc"))).toBe(true);
    expect(lines.some((l) => l.trim() === "/rc")).toBe(false);
  });

  it("carries decoy ❯ transcript lines above the composer", () => {
    // ❯ echoes of previously-run slash commands. The check must not mistake
    // these for the composer prompt — that is the #375 failure mode.
    for (const pane of [PANE_IDLE_HINT_OWN_ROW, PANE_IDLE_HINT_SAME_ROW]) {
      const lines = pane.split("\n");
      const border = lines.findIndex((l) => /^─{10,}/.test(l));
      expect(border).toBeGreaterThan(0);
      expect(lines.slice(0, border).some((l) => l.startsWith("❯ /"))).toBe(true);
    }
  });
});

describe("composer_region", () => {
  it("reaches the status bar past a deep footer", () => {
    // This pane renders /rc, a blank, a git branch row and a background agent
    // row below the status bar, putting it five lines from the end.
    const region = composer_region(PANE_IDLE_WITH_AGENT_FOOTER);
    expect(region.some((l) => l.includes("bypass permissions"))).toBe(true);
    expect(region.some((l) => l.includes("❯"))).toBe(true);
  });

  it("reaches the status bar past a tab indicator row", () => {
    const region = composer_region(PANE_IDLE_WITH_TAB_ROW);
    expect(region.some((l) => l.includes("bypass permissions"))).toBe(true);
  });

  it("excludes the transcript above the composer", () => {
    // The decoy `❯ /compact` and `❯ /mcp` echoes live above the composer
    // border and must not be part of the region.
    for (const pane of [PANE_IDLE_HINT_OWN_ROW, PANE_IDLE_HINT_SAME_ROW]) {
      const region = composer_region(pane);
      expect(region.some((l) => l.startsWith("❯ /"))).toBe(false);
    }
  });

  it("bounds the region when the pane has no composer at all", () => {
    // A pane that never rendered the TUI must not be scanned end to end, or
    // arbitrary scrollback could supply a false prompt match.
    const scrollback = `${Array.from({ length: 60 }, (_, i) => `❯ line ${i}`).join("\n")}\n`;
    expect(composer_region(scrollback).length).toBeLessThan(20);
  });
});

describe("is_pane_idle", () => {
  it("reads a long-idle pane as idle when /rc took its own row", () => {
    // Regression for #377. Pre-fix this returned false: the last line after
    // trim() was '                    /rc', which holds neither indicator, so
    // every untouched bot reported "working" and the pool became
    // permanently un-evictable once saturated.
    expect(is_pane_idle(PANE_IDLE_HINT_OWN_ROW)).toBe(true);
  });

  it("still reads a recently-active pane as idle when /rc shares the status bar", () => {
    // The one rendering that always worked. It must keep working — a fix
    // validated only against this case would look green and change nothing.
    expect(is_pane_idle(PANE_IDLE_HINT_SAME_ROW)).toBe(true);
  });

  it("reads an idle pane as idle behind a tab indicator row", () => {
    expect(is_pane_idle(PANE_IDLE_WITH_TAB_ROW)).toBe(true);
  });

  it("is not fooled by ❯ echoes in the transcript", () => {
    // Same pane as the working case, which carries ⏺ transcript lines above
    // the composer: the verdict must come from the status bar, not scrollback.
    expect(is_pane_idle(PANE_WORKING)).toBe(false);
  });

  it("lets active work win over the idle indicators on the same row", () => {
    // The status bar reads '⏵⏵ bypass permissions on … · esc to interrupt …'.
    // Both indicators are present on one line; the active one must win.
    const status = PANE_WORKING.trimEnd()
      .split("\n")
      .find((l) => l.includes("esc to interrupt"));
    expect(status).toContain("bypass permissions");
    expect(is_pane_idle(PANE_WORKING)).toBe(false);
  });

  it("treats a running background agent as work in progress", () => {
    // Claude Code now reports subagents with a `◯ <name>` footer row rather
    // than "N local agents" in the status bar. Without this, fixing the /rc
    // bug would newly make bots evictable while a subagent is still running.
    expect(PANE_IDLE_WITH_AGENT_FOOTER).toContain("◯ bob");
    expect(PANE_IDLE_WITH_AGENT_FOOTER).not.toContain("local agent");
    expect(is_pane_idle(PANE_IDLE_WITH_AGENT_FOOTER)).toBe(false);
  });

  it("still honours the legacy 'local agent' status bar wording", () => {
    // Older CLI builds put subagent counts in the status bar. Cheap to keep.
    const pane = PANE_IDLE_HINT_OWN_ROW.replace("← for agents", "2 local agents");
    expect(is_pane_idle(pane)).toBe(false);
  });
});
