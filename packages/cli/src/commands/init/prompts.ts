import * as p from "@clack/prompts";
import { DEFAULT_ARCHETYPES, type ArchetypeRole } from "@lobster-farm/shared";

/** Prompt for the user's name (required). */
export async function prompt_user_name(): Promise<string> {
  const name = await p.text({
    message: "What's your name?",
    placeholder: "e.g. Jax",
    validate: (value) => {
      if (!value.trim()) return "Name is required.";
      return undefined;
    },
  });
  if (p.isCancel(name)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return name.trim();
}

/** Prompt for agent names for the four configurable archetypes. */
export async function prompt_agent_names(): Promise<
  Record<"planner" | "designer" | "builder" | "operator", string>
> {
  p.note(
    "Your agents need names. Each role has a default — press Enter to keep it.",
    "Agent Names",
  );

  const roles: Array<"planner" | "designer" | "builder" | "operator"> = [
    "planner",
    "designer",
    "builder",
    "operator",
  ];

  const result: Record<string, string> = {};

  for (const role of roles) {
    const defaults = DEFAULT_ARCHETYPES[role as ArchetypeRole];
    const name = await p.text({
      message: `${role.charAt(0).toUpperCase() + role.slice(1)} agent name:`,
      placeholder: defaults.default_name,
      defaultValue: defaults.default_name,
    });
    if (p.isCancel(name)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    result[role] = name.trim() || defaults.default_name;
  }

  return result as Record<"planner" | "designer" | "builder" | "operator", string>;
}

/** Prompt for Discord setup (optional). Returns server ID or undefined. */
export async function prompt_discord(): Promise<string | undefined> {
  const wants_discord = await p.confirm({
    message: "Set up Discord integration?",
    initialValue: false,
  });
  if (p.isCancel(wants_discord)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  if (!wants_discord) return undefined;

  const server_id = await p.text({
    message: "Discord server ID:",
    placeholder: "e.g. 1234567890",
    validate: (value) => {
      if (!value.trim()) return "Server ID is required if enabling Discord.";
      return undefined;
    },
  });
  if (p.isCancel(server_id)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return server_id.trim();
}

/** Prompt for GitHub configuration. */
export async function prompt_github(): Promise<{
  username: string;
  org: string;
}> {
  const username = await p.text({
    message: "GitHub username (default):",
    placeholder: "e.g. jax",
    defaultValue: "",
  });
  if (p.isCancel(username)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const org = await p.text({
    message: "GitHub organization (default):",
    placeholder: "e.g. my-org",
    defaultValue: "",
  });
  if (p.isCancel(org)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return {
    username: (username ?? "").trim(),
    org: (org ?? "").trim(),
  };
}

/** Prompt for projects directory. */
export async function prompt_projects_dir(): Promise<string> {
  const dir = await p.text({
    message: "Projects directory:",
    placeholder: "~/projects",
    defaultValue: "~/projects",
  });
  if (p.isCancel(dir)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return (dir ?? "~/projects").trim();
}
