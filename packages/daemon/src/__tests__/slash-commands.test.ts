import { describe, expect, it, vi, afterEach } from "vitest";
import {
  build_slash_commands,
  extract_slash_args,
  format_relative_time,
  EPHEMERAL_COMMAND_NAMES,
  type CommandTarget,
  type SlashInteractionLike,
} from "../discord.js";

// ── build_slash_commands ──

describe("build_slash_commands", () => {
  const commands = build_slash_commands();

  it("returns all expected commands", () => {
    const names = commands.map(c => c.name);
    expect(names).toEqual([
      "help", "status", "features", "plan", "approve", "advance",
      "swap", "scaffold", "room", "close", "resume", "compact", "reset",
      "archives",
    ]);
  });

  it("every command has a name and description", () => {
    for (const cmd of commands) {
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
    }
  });

  it("/plan has a required title option", () => {
    const plan = commands.find(c => c.name === "plan")!;
    const options = plan.options;
    expect(options).toHaveLength(1);
    expect(options[0]!.toJSON().name).toBe("title");
    expect(options[0]!.toJSON().required).toBe(true);
  });

  it("/status has an optional scope option with entity/all choices", () => {
    const status = commands.find(c => c.name === "status")!;
    const options = status.options;
    expect(options).toHaveLength(1);
    const opt = options[0]!.toJSON();
    expect(opt.name).toBe("scope");
    expect(opt.required).toBeFalsy();
    expect(opt.choices).toHaveLength(2);
    const values = opt.choices!.map((c: { value: string }) => c.value);
    expect(values).toEqual(["entity", "all"]);
  });

  it("/swap has a required agent option with fixed choices", () => {
    const swap = commands.find(c => c.name === "swap")!;
    const options = swap.options;
    expect(options).toHaveLength(1);
    const opt = options[0]!.toJSON();
    expect(opt.name).toBe("agent");
    expect(opt.required).toBe(true);
    expect(opt.choices).toHaveLength(4);
    const values = opt.choices!.map((c: { value: string }) => c.value);
    expect(values).toContain("planner");
    expect(values).toContain("builder");
    expect(values).toContain("designer");
    expect(values).toContain("operator");
  });

  it("/resume has an autocomplete-enabled name option", () => {
    const resume = commands.find(c => c.name === "resume")!;
    const options = resume.options;
    expect(options).toHaveLength(1);
    const opt = options[0]!.toJSON();
    expect(opt.name).toBe("name");
    expect(opt.required).toBe(true);
    expect(opt.autocomplete).toBe(true);
  });

  it("/room has a required name option", () => {
    const room = commands.find(c => c.name === "room")!;
    const options = room.options;
    expect(options).toHaveLength(1);
    const opt = options[0]!.toJSON();
    expect(opt.name).toBe("name");
    expect(opt.required).toBe(true);
  });

  it("/scaffold has required name and optional blueprint options", () => {
    const scaffold = commands.find(c => c.name === "scaffold")!;
    const options = scaffold.options;
    expect(options).toHaveLength(2);
    const name_opt = options[0]!.toJSON();
    const bp_opt = options[1]!.toJSON();
    expect(name_opt.name).toBe("name");
    expect(name_opt.required).toBe(true);
    expect(bp_opt.name).toBe("blueprint");
    expect(bp_opt.required).toBeFalsy();
  });

  it("/approve and /advance have required feature options", () => {
    for (const cmd_name of ["approve", "advance"]) {
      const cmd = commands.find(c => c.name === cmd_name)!;
      const options = cmd.options;
      expect(options).toHaveLength(1);
      const opt = options[0]!.toJSON();
      expect(opt.name).toBe("feature");
      expect(opt.required).toBe(true);
    }
  });

  it("/help, /compact, /reset, /archives have no options", () => {
    for (const cmd_name of ["help", "compact", "reset", "archives"]) {
      const cmd = commands.find(c => c.name === cmd_name)!;
      expect(cmd.options).toHaveLength(0);
    }
  });

  it("/close has an optional force boolean option", () => {
    const close = commands.find(c => c.name === "close")!;
    const options = close.options;
    expect(options).toHaveLength(1);
    const opt = options[0]!.toJSON();
    expect(opt.name).toBe("force");
    expect(opt.required).toBeFalsy();
  });
});

// ── CommandTarget interface ──

describe("CommandTarget contract", () => {
  it("can create a mock target and capture replies", async () => {
    const replies: string[] = [];
    const reactions: string[] = [];
    const target: CommandTarget = {
      channel_id: "ch-test",
      author_name: "TestUser",
      async reply(content: string) { replies.push(content); },
      async react(emoji: string) { reactions.push(emoji); },
    };

    await target.reply("hello");
    await target.react("check");
    expect(replies).toEqual(["hello"]);
    expect(reactions).toEqual(["check"]);
    expect(target.channel_id).toBe("ch-test");
    expect(target.author_name).toBe("TestUser");
  });
});

// ── Ephemeral commands ──

describe("EPHEMERAL_COMMANDS", () => {
  it("EPHEMERAL_COMMAND_NAMES matches the spec (help, status, features, archives)", () => {
    expect([...EPHEMERAL_COMMAND_NAMES]).toEqual(["help", "status", "features", "archives"]);
  });

  it("all ephemeral and public commands are registered", () => {
    const public_names = ["plan", "approve", "advance", "swap", "scaffold",
      "room", "close", "resume", "compact", "reset"];

    const all_commands = build_slash_commands();
    const all_names = all_commands.map(c => c.name);

    for (const name of [...EPHEMERAL_COMMAND_NAMES, ...public_names]) {
      expect(all_names).toContain(name);
    }
  });
});

// ── extract_slash_args ──

/** Helper to create a mock interaction with named string/boolean options. */
function mock_interaction(
  commandName: string,
  strings: Record<string, string | null> = {},
  booleans: Record<string, boolean | null> = {},
): SlashInteractionLike {
  return {
    commandName,
    options: {
      getString(name: string) { return strings[name] ?? null; },
      getBoolean(name: string) { return booleans[name] ?? null; },
    },
  };
}

describe("extract_slash_args", () => {
  it("/plan extracts title", () => {
    expect(extract_slash_args(mock_interaction("plan", { title: "Add auth" }))).toEqual(["Add auth"]);
  });

  it("/plan with no title returns empty string", () => {
    expect(extract_slash_args(mock_interaction("plan"))).toEqual([""]);
  });

  it("/approve extracts feature id", () => {
    expect(extract_slash_args(mock_interaction("approve", { feature: "feat-42" }))).toEqual(["feat-42"]);
  });

  it("/advance with no feature returns empty array", () => {
    expect(extract_slash_args(mock_interaction("advance"))).toEqual([]);
  });

  it("/swap extracts agent name", () => {
    expect(extract_slash_args(mock_interaction("swap", { agent: "builder" }))).toEqual(["builder"]);
  });

  it("/scaffold name:server → ['server']", () => {
    expect(extract_slash_args(mock_interaction("scaffold", { name: "server" }))).toEqual(["server"]);
  });

  it("/scaffold name:my-entity → ['entity', 'my-entity']", () => {
    expect(extract_slash_args(mock_interaction("scaffold", { name: "my-entity" }))).toEqual(["entity", "my-entity"]);
  });

  it("/scaffold with blueprint → ['entity', name, '--blueprint', bp]", () => {
    expect(extract_slash_args(mock_interaction("scaffold", { name: "acme", blueprint: "custom" }))).toEqual([
      "entity", "acme", "--blueprint", "custom",
    ]);
  });

  it("/scaffold name:server ignores blueprint", () => {
    // "server" short-circuits before blueprint is checked
    expect(extract_slash_args(mock_interaction("scaffold", { name: "server", blueprint: "custom" }))).toEqual(["server"]);
  });

  it("/room extracts name", () => {
    expect(extract_slash_args(mock_interaction("room", { name: "auth-work" }))).toEqual(["auth-work"]);
  });

  it("/close with force:true → ['--force']", () => {
    expect(extract_slash_args(mock_interaction("close", {}, { force: true }))).toEqual(["--force"]);
  });

  it("/close with force:false → []", () => {
    expect(extract_slash_args(mock_interaction("close", {}, { force: false }))).toEqual([]);
  });

  it("/close with no force option → []", () => {
    expect(extract_slash_args(mock_interaction("close"))).toEqual([]);
  });

  it("/resume extracts name", () => {
    expect(extract_slash_args(mock_interaction("resume", { name: "old-session" }))).toEqual(["old-session"]);
  });

  it("unknown command returns empty array", () => {
    expect(extract_slash_args(mock_interaction("unknown"))).toEqual([]);
  });

  it("/status with scope:entity → ['entity']", () => {
    expect(extract_slash_args(mock_interaction("status", { scope: "entity" }))).toEqual(["entity"]);
  });

  it("/status with scope:all → ['all']", () => {
    expect(extract_slash_args(mock_interaction("status", { scope: "all" }))).toEqual(["all"]);
  });

  it("/status with no scope → []", () => {
    expect(extract_slash_args(mock_interaction("status"))).toEqual([]);
  });

  it("/help returns empty array (no options)", () => {
    expect(extract_slash_args(mock_interaction("help"))).toEqual([]);
  });

  it("/archives returns empty array (no options)", () => {
    expect(extract_slash_args(mock_interaction("archives"))).toEqual([]);
  });
});

// ── format_relative_time ──

describe("format_relative_time", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for timestamps less than a minute ago", () => {
    vi.useFakeTimers({ now: new Date("2026-03-28T12:00:00Z") });
    expect(format_relative_time("2026-03-28T12:00:00Z")).toBe("just now");
    expect(format_relative_time("2026-03-28T11:59:30Z")).toBe("just now");
  });

  it("returns minutes for timestamps under an hour ago", () => {
    vi.useFakeTimers({ now: new Date("2026-03-28T12:00:00Z") });
    expect(format_relative_time("2026-03-28T11:55:00Z")).toBe("5m ago");
    expect(format_relative_time("2026-03-28T11:15:00Z")).toBe("45m ago");
  });

  it("returns hours for timestamps under a day ago", () => {
    vi.useFakeTimers({ now: new Date("2026-03-28T12:00:00Z") });
    expect(format_relative_time("2026-03-28T10:00:00Z")).toBe("2h ago");
    expect(format_relative_time("2026-03-27T13:00:00Z")).toBe("23h ago");
  });

  it("returns days for timestamps over a day ago", () => {
    vi.useFakeTimers({ now: new Date("2026-03-28T12:00:00Z") });
    expect(format_relative_time("2026-03-27T12:00:00Z")).toBe("1d ago");
    expect(format_relative_time("2026-03-25T12:00:00Z")).toBe("3d ago");
  });

  it("returns 'just now' for future timestamps", () => {
    vi.useFakeTimers({ now: new Date("2026-03-28T12:00:00Z") });
    expect(format_relative_time("2026-03-28T13:00:00Z")).toBe("just now");
  });
});
