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

/** Prompt for agent names for the configurable archetypes. */
export async function prompt_agent_names(): Promise<
  Record<"planner" | "designer" | "builder" | "operator" | "commander", string>
> {
  p.note(
    "Your agents need names. Each role has a default — press Enter to keep it.",
    "Agent Names",
  );

  const roles: Array<"planner" | "designer" | "builder" | "operator" | "commander"> = [
    "planner",
    "designer",
    "builder",
    "operator",
    "commander",
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

  return result as Record<"planner" | "designer" | "builder" | "operator" | "commander", string>;
}

export interface DiscordSetup {
  server_id: string;
  daemon_bot_token: string;
  commander_bot_token?: string;
  /** The user's Discord ID — used for pool bot access control and Pat's allowlist. */
  user_id?: string;
}

/** Prompt for Discord setup (optional). Returns server ID + bot tokens or undefined. */
export async function prompt_discord(existing_token?: boolean): Promise<DiscordSetup | undefined> {
  if (existing_token) {
    const overwrite = await p.confirm({
      message: "Discord bot tokens already configured. Update them?",
      initialValue: false,
    });
    if (p.isCancel(overwrite)) { p.cancel("Setup cancelled."); process.exit(0); }
    if (!overwrite) return undefined;
  } else {
    const wants_discord = await p.confirm({
      message: "Set up Discord integration?",
      initialValue: true,
    });
    if (p.isCancel(wants_discord)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    if (!wants_discord) return undefined;
  }

  p.note(
    "LobsterFarm uses multiple Discord bots. You'll create them one at a time.\n\n" +
      "To copy Discord IDs, enable Developer Mode first:\n" +
      "  Discord → User Settings → Advanced → Developer Mode toggle ON\n\n" +
      "Then right-click the server name → Copy Server ID.",
    "Discord Setup",
  );

  const server_id = await p.text({
    message: "Discord server ID:",
    placeholder: "e.g. 1234567890",
    validate: (value) => {
      if (!value.trim()) return "Server ID is required.";
      return undefined;
    },
  });
  if (p.isCancel(server_id)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  p.note(
    'Step 1: Go to https://discord.com/developers/applications\n' +
      'Step 2: Click "New Application" → name it "Daemon"\n' +
      'Step 3: In the Installation tab → set Install Link to "None"\n' +
      "Step 4: In the Bot tab:\n" +
      '  - Uncheck "Public Bot"\n' +
      "  - Enable all 3 Privileged Gateway Intents:\n" +
      "    Presence Intent, Server Members Intent, Message Content Intent\n" +
      '  - Click "Reset Token" → copy the token',
    "Create Daemon Bot",
  );

  const daemon_token = await p.password({
    message: "Daemon bot token:",
    validate: (value) => {
      if (!value.trim()) return "Daemon bot token is required.";
      return undefined;
    },
  });
  if (p.isCancel(daemon_token)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  p.note(
    'Step 1: Go to https://discord.com/developers/applications\n' +
      'Step 2: Click "New Application" → name it "Pat"\n' +
      'Step 3: In the Installation tab → set Install Link to "None"\n' +
      "Step 4: In the Bot tab:\n" +
      '  - Uncheck "Public Bot"\n' +
      "  - Enable all 3 Privileged Gateway Intents:\n" +
      "    Presence Intent, Server Members Intent, Message Content Intent\n" +
      '  - Click "Reset Token" → copy the token',
    "Create Commander Bot (Pat)",
  );

  const commander_token = await p.password({
    message: "Commander bot token (Pat — press Enter to skip):",
  });
  if (p.isCancel(commander_token)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const user_id = await p.text({
    message: "Your Discord user ID (right-click your avatar → Copy User ID, or press Enter to skip):",
    defaultValue: "",
  });
  if (p.isCancel(user_id)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return {
    server_id: server_id.trim(),
    daemon_bot_token: daemon_token.trim(),
    commander_bot_token: commander_token?.trim() || undefined,
    user_id: (user_id ?? "").trim() || undefined,
  };
}

/** Prompt for default GitHub account. */
export async function prompt_github(): Promise<{
  username: string;
}> {
  const username = await p.text({
    message: "Default GitHub account (used for all entities unless overridden):",
    placeholder: "e.g. my-org",
    defaultValue: "",
  });
  if (p.isCancel(username)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return {
    username: (username ?? "").trim(),
  };
}

/** Prompt for how many pool bots to create. Returns 0 if the user declines. */
export async function prompt_pool_bot_count(): Promise<number> {
  p.note(
    "Pool bots are your workers — each one can run one agent session at a time.\n" +
      "3 bots = 3 concurrent sessions (e.g., a planner, a builder, and a reviewer).",
    "Pool Bot Setup",
  );

  const count = await p.text({
    message: "How many pool bots to create? (recommended: 3, max: 10, 0 to skip)",
    placeholder: "3",
    defaultValue: "3",
    validate: (value) => {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 0 || n > 10) return "Enter a number between 0 and 10.";
      return undefined;
    },
  });
  if (p.isCancel(count)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return parseInt(count, 10);
}

/** Prompt for a single pool bot token. Shows step-by-step creation guidance. */
export async function prompt_pool_bot_token(index: number): Promise<string> {
  p.note(
    `Step 1: Go to https://discord.com/developers/applications\n` +
      `Step 2: Click "New Application" → name it "LF-${String(index)}"\n` +
      'Step 3: In the Installation tab → set Install Link to "None"\n' +
      "Step 4: In the Bot tab:\n" +
      '  - Uncheck "Public Bot"\n' +
      "  - Enable all 3 Privileged Gateway Intents:\n" +
      "    Presence Intent, Server Members Intent, Message Content Intent\n" +
      '  - Click "Reset Token" → copy the token',
    `Create Pool Bot LF-${String(index)}`,
  );

  const token = await p.password({
    message: `LF-${String(index)} bot token:`,
    validate: (value) => {
      if (!value.trim()) return "Bot token is required.";
      return undefined;
    },
  });
  if (p.isCancel(token)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return token.trim();
}

/** Prompt for entities directory (where entity repos live on disk). */
export async function prompt_projects_dir(): Promise<string> {
  const dir = await p.text({
    message: "Entities directory (where entity repos will live on disk):",
    placeholder: "~/entities",
    defaultValue: "~/entities",
  });
  if (p.isCancel(dir)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return (dir ?? "~/entities").trim();
}
