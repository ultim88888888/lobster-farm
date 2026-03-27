import { describe, expect, it } from "vitest";
import {
  route_message,
  parse_command,
  classify_intent,
  type RoutedMessage,
} from "../router.js";

function make_msg(overrides: Partial<RoutedMessage> = {}): RoutedMessage {
  return {
    entity_id: "alpha",
    channel_type: "general",
    content: "",
    author: "user#1234",
    channel_id: "chan-123",
    ...overrides,
  };
}

describe("parse_command", () => {
  it("parses simple command", () => {
    const cmd = parse_command("!lf status");
    expect(cmd).toEqual({ name: "status", args: [] });
  });

  it("parses command with args", () => {
    const cmd = parse_command("!lf plan alpha Dashboard");
    expect(cmd).toEqual({ name: "plan", args: ["alpha", "Dashboard"] });
  });

  it("parses command with quoted args", () => {
    const cmd = parse_command('!lf plan alpha "Custom Chart Module"');
    expect(cmd).toEqual({ name: "plan", args: ["alpha", "Custom Chart Module"] });
  });

  it("parses command with single-quoted args", () => {
    const cmd = parse_command("!lf plan alpha 'My Feature'");
    expect(cmd).toEqual({ name: "plan", args: ["alpha", "My Feature"] });
  });

  it("returns null for non-commands", () => {
    expect(parse_command("hello world")).toBeNull();
    expect(parse_command("!lfx something")).toBeNull();
  });

  it("returns help for bare !lf with no subcommand", () => {
    expect(parse_command("!lf")).toEqual({ name: "help", args: [] });
    expect(parse_command("!lf ")).toEqual({ name: "help", args: [] });
  });
});

describe("classify_intent", () => {
  it("classifies planning intent", () => {
    const result = classify_intent("I need to plan the architecture for the new API");
    expect(result?.archetype).toBe("planner");
  });

  it("classifies design intent", () => {
    const result = classify_intent("Create a brand new UI for the dashboard");
    expect(result?.archetype).toBe("designer");
  });

  it("classifies builder intent", () => {
    const result = classify_intent("Implement the REST API endpoint and write tests for it");
    expect(result?.archetype).toBe("builder");
  });

  it("classifies operator intent", () => {
    const result = classify_intent("Set up the CI/CD pipeline and deploy to staging");
    expect(result?.archetype).toBe("operator");
  });

  it("classifies reviewer intent", () => {
    const result = classify_intent("Review the pull request for the auth module");
    expect(result?.archetype).toBe("reviewer");
  });

  it("returns null for ambiguous messages", () => {
    const result = classify_intent("hello there");
    expect(result).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(classify_intent("")).toBeNull();
  });
});

describe("route_message", () => {
  describe("command routing", () => {
    it("routes !lf commands", () => {
      const result = route_message(make_msg({ content: "!lf status" }));
      expect(result.type).toBe("command");
      if (result.type === "command") {
        expect(result.name).toBe("status");
      }
    });

    it("parses command args correctly", () => {
      const result = route_message(make_msg({ content: '!lf plan alpha "New Feature"' }));
      expect(result.type).toBe("command");
      if (result.type === "command") {
        expect(result.name).toBe("plan");
        expect(result.args).toEqual(["alpha", "New Feature"]);
      }
    });
  });

  describe("alerts channel routing", () => {
    it("routes alerts messages as approval responses", () => {
      const result = route_message(make_msg({
        channel_type: "alerts",
        content: "Looks good, ship it",
      }));
      expect(result.type).toBe("approval_response");
    });

    it("still handles commands in alerts channel", () => {
      const result = route_message(make_msg({
        channel_type: "alerts",
        content: "!lf approve alpha-42",
      }));
      expect(result.type).toBe("command");
    });
  });

  describe("work room routing", () => {
    it("routes to assigned feature session", () => {
      const result = route_message(make_msg({
        channel_type: "work_room",
        content: "Use a grid layout for the cards",
        assigned_feature: "alpha-42",
      }));
      expect(result.type).toBe("route_to_session");
      if (result.type === "route_to_session") {
        expect(result.feature_id).toBe("alpha-42");
      }
    });

    it("does not route unassigned work room messages", () => {
      const result = route_message(make_msg({
        channel_type: "work_room",
        content: "hello",
        assigned_feature: null,
      }));
      // No assigned feature, falls through to ignore
      expect(result.type).toBe("ignore");
    });
  });

  describe("general channel routing", () => {
    it("classifies intent for build tasks", () => {
      const result = route_message(make_msg({
        channel_type: "general",
        content: "Build the REST API endpoint for orders",
      }));
      expect(result.type).toBe("classify");
      if (result.type === "classify") {
        expect(result.archetype).toBe("builder");
      }
    });

    it("asks for clarification on ambiguous messages", () => {
      const result = route_message(make_msg({
        channel_type: "general",
        content: "hello how are you",
      }));
      expect(result.type).toBe("ask_clarification");
    });
  });

  describe("work log routing", () => {
    it("ignores work log messages", () => {
      const result = route_message(make_msg({
        channel_type: "work_log",
        content: "anything here",
      }));
      expect(result.type).toBe("ignore");
    });
  });
});
