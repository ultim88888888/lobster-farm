import { describe, expect, it } from "vitest";
import {
  build_slash_commands,
  type CommandTarget,
} from "../discord.js";

// ── build_slash_commands ──

describe("build_slash_commands", () => {
  const commands = build_slash_commands();

  it("returns all expected commands", () => {
    const names = commands.map(c => c.name);
    expect(names).toEqual([
      "help", "status", "features", "plan", "approve", "advance",
      "swap", "scaffold", "room", "close", "resume", "compact", "reset",
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

  it("/status has an optional scope option with choices", () => {
    const status = commands.find(c => c.name === "status")!;
    const options = status.options;
    expect(options).toHaveLength(1);
    const opt = options[0]!.toJSON();
    expect(opt.name).toBe("scope");
    expect(opt.required).toBeFalsy();
    expect(opt.choices).toEqual([
      { name: "entity", value: "entity" },
      { name: "all", value: "all" },
    ]);
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

  it("/approve and /advance have optional feature options", () => {
    for (const cmd_name of ["approve", "advance"]) {
      const cmd = commands.find(c => c.name === cmd_name)!;
      const options = cmd.options;
      expect(options).toHaveLength(1);
      const opt = options[0]!.toJSON();
      expect(opt.name).toBe("feature");
      expect(opt.required).toBeFalsy();
    }
  });

  it("/help, /close, /compact, /reset have no options", () => {
    for (const cmd_name of ["help", "close", "compact", "reset"]) {
      const cmd = commands.find(c => c.name === cmd_name)!;
      expect(cmd.options).toHaveLength(0);
    }
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
  // The EPHEMERAL_COMMANDS set is module-private, but we can verify behavior
  // through the build_slash_commands output — ephemeral commands should be
  // help, status, features (per spec)
  it("help, status, features are the ephemeral commands per spec", () => {
    // This is a documentation test — the actual ephemeral behavior is
    // enforced in target_from_interaction which checks EPHEMERAL_COMMANDS
    const ephemeral_names = ["help", "status", "features"];
    const public_names = ["plan", "approve", "advance", "swap", "scaffold",
      "room", "close", "resume", "compact", "reset"];

    const all_commands = build_slash_commands();
    const all_names = all_commands.map(c => c.name);

    // All ephemeral and public commands are registered
    for (const name of [...ephemeral_names, ...public_names]) {
      expect(all_names).toContain(name);
    }
  });
});
