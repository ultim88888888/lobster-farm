import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promisify } from "node:util";

// Create a callback-style mock function that promisify can wrap properly.
// Node's execFile has a custom promisify symbol, but a plain vi.fn() does not.
// We define a mock that supports the (cmd, args, opts, callback) signature
// and add a custom promisify wrapper so the module under test works correctly.
let keychain_result: { stdout: string; error: Error | null } = { stdout: "", error: null };

const mock_exec_file = Object.assign(
  vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    if (keychain_result.error) {
      cb(keychain_result.error, "", "");
    } else {
      cb(null, keychain_result.stdout, "");
    }
    return {} as never;
  }),
  {
    // Custom promisify implementation so promisify(execFile) works in the module
    [promisify.custom]: (...args: unknown[]) => {
      return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        if (keychain_result.error) {
          reject(keychain_result.error);
        } else {
          resolve({ stdout: keychain_result.stdout, stderr: "" });
        }
        // Still call the base mock so we can assert on call args
        mock_exec_file(args[0] as string, args[1] as string[], args[2] as unknown, () => {});
      });
    },
  },
);

vi.mock("node:child_process", () => ({
  execFile: mock_exec_file,
}));

// Mock sentry
vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
}));

// Import after mocks are established
const { fetch_subscription_usage, read_oauth_credentials } = await import("../usage-api.js");
import type { SubscriptionUsageResponse } from "../usage-api.js";

describe("read_oauth_credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses OAuth credentials from Keychain JSON", async () => {
    keychain_result = {
      stdout: JSON.stringify({
        claudeAiOauth: {
          accessToken: "test-token-123",
          refreshToken: "refresh-456",
          expiresAt: "2026-04-01T00:00:00Z",
          scopes: ["usage"],
          rateLimitTier: "pro",
        },
      }),
      error: null,
    };

    const creds = await read_oauth_credentials();
    expect(creds.accessToken).toBe("test-token-123");
    expect(creds.refreshToken).toBe("refresh-456");
    expect(creds.scopes).toEqual(["usage"]);
  });

  it("throws when credentials have no accessToken", async () => {
    keychain_result = {
      stdout: JSON.stringify({
        claudeAiOauth: { refreshToken: "refresh-only" },
      }),
      error: null,
    };

    await expect(read_oauth_credentials()).rejects.toThrow("No claudeAiOauth.accessToken");
  });

  it("throws when Keychain read fails", async () => {
    keychain_result = {
      stdout: "",
      error: new Error("security: SecKeychainSearchCopyNext: not found"),
    };

    await expect(read_oauth_credentials()).rejects.toThrow("SecKeychainSearchCopyNext");
  });
});

describe("fetch_subscription_usage", () => {
  let fetch_spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetch_spy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetch_spy.mockRestore();
  });

  it("returns formatted summary on success", async () => {
    keychain_result = {
      stdout: JSON.stringify({
        claudeAiOauth: { accessToken: "test-token", expiresAt: "2099-01-01T00:00:00Z" },
      }),
      error: null,
    };

    const api_response: SubscriptionUsageResponse = {
      five_hour: { utilization: 5, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      seven_day: { utilization: 29, resets_at: new Date(Date.now() + 2 * 86_400_000 + 4 * 3_600_000).toISOString() },
    };

    fetch_spy.mockResolvedValueOnce(new Response(JSON.stringify(api_response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await fetch_subscription_usage();
    expect(result).not.toBeNull();
    expect(result!.summary).toContain("5h: 5%");
    expect(result!.summary).toContain("Weekly: 29%");
    expect(result!.raw.five_hour?.utilization).toBe(5);
  });

  it("sends correct Authorization header and beta flag", async () => {
    keychain_result = {
      stdout: JSON.stringify({
        claudeAiOauth: { accessToken: "bearer-test-abc", expiresAt: "2099-01-01T00:00:00Z" },
      }),
      error: null,
    };

    fetch_spy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    await fetch_subscription_usage();

    expect(fetch_spy).toHaveBeenCalledOnce();
    const call_args = fetch_spy.mock.calls[0]!;
    expect(call_args[0]).toBe("https://api.anthropic.com/api/oauth/usage");
    const headers = (call_args[1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer bearer-test-abc");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("returns null when API returns error status", async () => {
    keychain_result = {
      stdout: JSON.stringify({
        claudeAiOauth: { accessToken: "test-token", expiresAt: "2099-01-01T00:00:00Z" },
      }),
      error: null,
    };

    fetch_spy.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

    const result = await fetch_subscription_usage();
    expect(result).toBeNull();
  });

  it("returns null when Keychain read fails", async () => {
    keychain_result = {
      stdout: "",
      error: new Error("security: not found"),
    };

    const result = await fetch_subscription_usage();
    expect(result).toBeNull();
  });

  it("includes extra usage when enabled", async () => {
    keychain_result = {
      stdout: JSON.stringify({
        claudeAiOauth: { accessToken: "test-token", expiresAt: "2099-01-01T00:00:00Z" },
      }),
      error: null,
    };

    const api_response: SubscriptionUsageResponse = {
      five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 23.5, utilization: 23.5 },
    };

    fetch_spy.mockResolvedValueOnce(new Response(JSON.stringify(api_response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await fetch_subscription_usage();
    expect(result).not.toBeNull();
    expect(result!.summary).toContain("Extra: $23.50/$100");
  });

  it("formats resets_in for weekly usage", async () => {
    keychain_result = {
      stdout: JSON.stringify({
        claudeAiOauth: { accessToken: "test-token", expiresAt: "2099-01-01T00:00:00Z" },
      }),
      error: null,
    };

    const api_response: SubscriptionUsageResponse = {
      seven_day: { utilization: 50, resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString() },
    };

    fetch_spy.mockResolvedValueOnce(new Response(JSON.stringify(api_response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await fetch_subscription_usage();
    expect(result).not.toBeNull();
    expect(result!.summary).toContain("Weekly: 50%");
    expect(result!.summary).toMatch(/resets in \dd \d+h/);
  });

  it("returns summary string even with empty response", async () => {
    keychain_result = {
      stdout: JSON.stringify({
        claudeAiOauth: { accessToken: "test-token", expiresAt: "2099-01-01T00:00:00Z" },
      }),
      error: null,
    };

    fetch_spy.mockResolvedValueOnce(new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await fetch_subscription_usage();
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("No usage data available");
  });
});
