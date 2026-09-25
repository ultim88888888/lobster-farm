/**
 * Regression test: a finalize that lands while the status embed's initial
 * `channel.send()` is still in flight must not orphan the message.
 *
 * send_status_embed claims its map slot before awaiting the send, so a second
 * caller can arrive, see the slot, and finalize it. Before the fix, finalize
 * read `message_id === ""`, concluded there was nothing to clean up, and
 * deleted the slot — then the in-flight send resolved and posted an embed that
 * nothing held a reference to. It sat on "Working" forever while the next
 * message posted a second embed beside it, which is the user-visible symptom:
 * two status bubbles per message instead of one.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: vi.fn().mockReturnValue(""), spawn: vi.fn() };
});

vi.mock("discord.js", async () => {
  const actual = await vi.importActual<typeof import("discord.js")>("discord.js");
  return {
    ...actual,
    Client: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      once: vi.fn(),
      login: vi.fn(),
      destroy: vi.fn(),
      user: null,
      channels: { fetch: vi.fn() },
      guilds: { fetch: vi.fn() },
      application: null,
    })),
  };
});

import { DiscordBot } from "../discord.js";
import { EntityRegistry } from "../registry.js";

const CHANNEL = "channel-under-test";
const MESSAGE_ID = "posted-embed-1";

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
}

/** A deferred so the test controls exactly when `channel.send()` resolves. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("status embed / finalize racing the initial send", () => {
  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "lf-embed-race-"));
  });

  afterEach(async () => {
    await rm(temp_dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("edits the message that was still in flight instead of orphaning it", async () => {
    const registry = new EntityRegistry(make_config());
    const bot = new DiscordBot(make_config(), registry);
    const internals = bot as unknown as {
      connected: boolean;
      client: { channels: { fetch: ReturnType<typeof vi.fn> } };
      status_embeds: Map<string, { message_id: string }>;
      send_status_embed: (c: string, a: string) => Promise<void>;
      finalize_status_embed: (c: string) => Promise<void>;
    };
    internals.connected = true;

    const send_gate = deferred<{ id: string }>();
    const edit = vi.fn().mockResolvedValue(undefined);
    const channel = {
      isTextBased: () => true,
      send: vi.fn().mockReturnValue(send_gate.promise),
      messages: { fetch: vi.fn().mockResolvedValue({ id: MESSAGE_ID, edit }) },
    };
    internals.client.channels.fetch = vi.fn().mockResolvedValue(channel);

    // 1. First message: send is in flight and message_id is not yet assigned.
    const sending = internals.send_status_embed(CHANNEL, "planner");
    expect(internals.status_embeds.get(CHANNEL)?.message_id).toBe("");

    // 2. A second message arrives and finalizes the slot mid-send.
    const finalizing = internals.finalize_status_embed(CHANNEL);

    // 3. Discord now returns the ID for the embed posted in step 1.
    send_gate.resolve({ id: MESSAGE_ID });
    await sending;
    await finalizing;

    // The in-flight message must have been finalized, not stranded. Before the
    // fix `edit` was never called and the embed stayed on "Working" forever.
    expect(channel.messages.fetch).toHaveBeenCalledWith(MESSAGE_ID);
    expect(edit).toHaveBeenCalledTimes(1);
    // The slot is released either way, so the next message starts clean.
    expect(internals.status_embeds.has(CHANNEL)).toBe(false);
  });

  it("still returns quietly when the send genuinely failed", async () => {
    const registry = new EntityRegistry(make_config());
    const bot = new DiscordBot(make_config(), registry);
    const internals = bot as unknown as {
      connected: boolean;
      client: { channels: { fetch: ReturnType<typeof vi.fn> } };
      status_embeds: Map<string, { message_id: string }>;
      send_status_embed: (c: string, a: string) => Promise<void>;
      finalize_status_embed: (c: string) => Promise<void>;
    };
    internals.connected = true;

    const messages_fetch = vi.fn();
    internals.client.channels.fetch = vi.fn().mockResolvedValue({
      isTextBased: () => true,
      send: vi.fn().mockRejectedValue(new Error("discord 503")),
      messages: { fetch: messages_fetch },
    });

    await internals.send_status_embed(CHANNEL, "planner");
    await internals.finalize_status_embed(CHANNEL);

    // Nothing was ever posted, so there is nothing to edit and no throw.
    expect(messages_fetch).not.toHaveBeenCalled();
    expect(internals.status_embeds.has(CHANNEL)).toBe(false);
  });
});
