import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { GitHubAppAuth, init_github_app_from_env } from "../github-app.js";

// Generate a real RSA key pair for testing JWT signing
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const TEST_CONFIG = {
  app_id: "12345",
  private_key: privateKey,
  installation_id: "67890",
  webhook_secret: "test-webhook-secret-value",
};

describe("GitHubAppAuth", () => {
  describe("verify_signature", () => {
    it("accepts a valid HMAC-SHA256 signature", () => {
      const auth = new GitHubAppAuth(TEST_CONFIG);
      const payload = '{"action":"opened","pull_request":{}}';
      const hmac = createHmac("sha256", TEST_CONFIG.webhook_secret)
        .update(payload)
        .digest("hex");
      const signature = `sha256=${hmac}`;

      expect(auth.verify_signature(payload, signature)).toBe(true);
    });

    it("rejects an invalid signature", () => {
      const auth = new GitHubAppAuth(TEST_CONFIG);
      const payload = '{"action":"opened"}';
      const signature = "sha256=0000000000000000000000000000000000000000000000000000000000000000";

      expect(auth.verify_signature(payload, signature)).toBe(false);
    });

    it("rejects a signature without sha256= prefix", () => {
      const auth = new GitHubAppAuth(TEST_CONFIG);
      const payload = "test";
      const hmac = createHmac("sha256", TEST_CONFIG.webhook_secret)
        .update(payload)
        .digest("hex");

      expect(auth.verify_signature(payload, hmac)).toBe(false);
    });

    it("rejects an empty signature", () => {
      const auth = new GitHubAppAuth(TEST_CONFIG);
      expect(auth.verify_signature("payload", "")).toBe(false);
    });

    it("accepts Buffer payloads", () => {
      const auth = new GitHubAppAuth(TEST_CONFIG);
      const payload = Buffer.from('{"test":true}');
      const hmac = createHmac("sha256", TEST_CONFIG.webhook_secret)
        .update(payload)
        .digest("hex");
      const signature = `sha256=${hmac}`;

      expect(auth.verify_signature(payload, signature)).toBe(true);
    });

    it("rejects signature with wrong length", () => {
      const auth = new GitHubAppAuth(TEST_CONFIG);
      // Hex digest should be 64 chars, provide one that's shorter
      expect(auth.verify_signature("payload", "sha256=abc")).toBe(false);
    });
  });

  describe("get_token", () => {
    it("fetches a token from the GitHub API", async () => {
      const auth = new GitHubAppAuth(TEST_CONFIG);
      const expires_at = new Date(Date.now() + 3600_000).toISOString();

      const mock_fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ token: "ghs_test_token_123", expires_at }),
      });
      vi.stubGlobal("fetch", mock_fetch);

      const token = await auth.get_token();

      expect(token).toBe("ghs_test_token_123");
      expect(mock_fetch).toHaveBeenCalledTimes(1);

      // Verify it called the correct URL
      const call_url = mock_fetch.mock.calls[0]![0] as string;
      expect(call_url).toContain("/app/installations/67890/access_tokens");

      // Verify Authorization header is a Bearer JWT
      const call_opts = mock_fetch.mock.calls[0]![1] as { headers: Record<string, string> };
      expect(call_opts.headers["Authorization"]).toMatch(/^Bearer eyJ/);

      vi.unstubAllGlobals();
    });

    it("returns cached token on subsequent calls", async () => {
      const auth = new GitHubAppAuth(TEST_CONFIG);
      const expires_at = new Date(Date.now() + 3600_000).toISOString();

      const mock_fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ token: "ghs_cached", expires_at }),
      });
      vi.stubGlobal("fetch", mock_fetch);

      const token1 = await auth.get_token();
      const token2 = await auth.get_token();

      expect(token1).toBe("ghs_cached");
      expect(token2).toBe("ghs_cached");
      // Only one API call — second call used cache
      expect(mock_fetch).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });

    it("throws on API error", async () => {
      const auth = new GitHubAppAuth(TEST_CONFIG);

      const mock_fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Bad credentials",
      });
      vi.stubGlobal("fetch", mock_fetch);

      await expect(auth.get_token()).rejects.toThrow("Failed to get installation token: 401");

      vi.unstubAllGlobals();
    });

    it("coalesces concurrent refresh calls", async () => {
      const auth = new GitHubAppAuth(TEST_CONFIG);
      const expires_at = new Date(Date.now() + 3600_000).toISOString();

      let resolve_fetch!: (value: unknown) => void;
      const fetch_promise = new Promise((r) => { resolve_fetch = r; });

      const mock_fetch = vi.fn().mockReturnValue(fetch_promise);
      vi.stubGlobal("fetch", mock_fetch);

      // Start two concurrent get_token calls
      const p1 = auth.get_token();
      const p2 = auth.get_token();

      // Resolve the fetch
      resolve_fetch({
        ok: true,
        json: async () => ({ token: "ghs_coalesced", expires_at }),
      });

      const [t1, t2] = await Promise.all([p1, p2]);

      expect(t1).toBe("ghs_coalesced");
      expect(t2).toBe("ghs_coalesced");
      // Only one API call despite two concurrent requests
      expect(mock_fetch).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });
  });
});

describe("init_github_app_from_env", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Clean env for each test
    delete process.env["GITHUB_APP_ID"];
    delete process.env["GITHUB_APP_PRIVATE_KEY"];
    delete process.env["GITHUB_APP_INSTALLATION_ID"];
    delete process.env["GITHUB_APP_WEBHOOK_SECRET"];
  });

  // Restore env after tests
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("returns null when env vars are missing", () => {
    const result = init_github_app_from_env();
    expect(result).toBeNull();
  });

  it("returns null when only some env vars are set", () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = privateKey;
    // Missing INSTALLATION_ID and WEBHOOK_SECRET

    const result = init_github_app_from_env();
    expect(result).toBeNull();
  });

  it("returns GitHubAppAuth when all env vars are set", () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = privateKey;
    process.env["GITHUB_APP_INSTALLATION_ID"] = "456";
    process.env["GITHUB_APP_WEBHOOK_SECRET"] = "secret";

    const result = init_github_app_from_env();
    expect(result).toBeInstanceOf(GitHubAppAuth);
  });
});
