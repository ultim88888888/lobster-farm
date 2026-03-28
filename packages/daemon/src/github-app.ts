/**
 * GitHub App authentication module.
 *
 * Handles JWT creation (RS256), installation token management, and webhook
 * signature verification — all using Node.js built-in `crypto`. No external
 * dependencies.
 *
 * Tokens are cached and refreshed 10 minutes before expiry (GitHub installation
 * tokens last 1 hour, so we refresh at 50 min).
 */

import { createSign, createHmac, timingSafeEqual } from "node:crypto";

// ── Types ──

export interface GitHubAppConfig {
  app_id: string;
  private_key: string; // PEM contents
  installation_id: string;
  webhook_secret: string;
}

interface CachedToken {
  token: string;
  expires_at: number; // Unix ms
}

// ── Constants ──

/** Refresh token when it has less than this many ms remaining. */
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000; // 10 min

/** JWT is valid for 10 minutes (GitHub max). */
const JWT_EXPIRY_SECONDS = 600;

/** Clock skew allowance — backdate `iat` by 60 seconds. */
const JWT_IAT_DRIFT_SECONDS = 60;

// ── Helpers ──

/** Base64url-encode a buffer or string. */
function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Normalize a PEM private key from env var injection.
 *
 * 1Password / `op run` can deliver the key with:
 * - Literal `\n` instead of real newlines
 * - Everything on one line (spaces where newlines were)
 * - Correct multi-line format (pass-through)
 */
function normalize_pem(raw: string): string {
  // Already has real newlines and looks like a PEM — pass through
  if (raw.includes("\n") && raw.startsWith("-----BEGIN")) {
    return raw;
  }

  // Replace literal \n sequences with real newlines
  let normalized = raw.replace(/\\n/g, "\n");

  // If still no newlines, try reconstructing from space-separated or continuous base64
  if (!normalized.includes("\n") && normalized.includes("-----BEGIN")) {
    // Extract the header, base64 body, and footer
    const match = normalized.match(
      /^(-----BEGIN [A-Z ]+-----)(.+)(-----END [A-Z ]+-----)$/,
    );
    if (match) {
      const [, header, body, footer] = match;
      // Split base64 body into 64-char lines
      const clean_body = body!.replace(/\s+/g, "");
      const lines: string[] = [];
      for (let i = 0; i < clean_body.length; i += 64) {
        lines.push(clean_body.slice(i, i + 64));
      }
      normalized = `${header}\n${lines.join("\n")}\n${footer}\n`;
    }
  }

  return normalized;
}

// ── Class ──

export class GitHubAppAuth {
  private cached: CachedToken | null = null;
  private refresh_promise: Promise<string> | null = null;

  constructor(private config: GitHubAppConfig) {}

  // ── JWT ──

  /** Generate a short-lived JWT for the GitHub App (RS256). */
  private sign_jwt(): string {
    const now = Math.floor(Date.now() / 1000);

    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(
      JSON.stringify({
        iss: this.config.app_id,
        iat: now - JWT_IAT_DRIFT_SECONDS,
        exp: now + JWT_EXPIRY_SECONDS,
      }),
    );

    const sign = createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    sign.end();

    const signature = base64url(sign.sign(this.config.private_key));
    return `${header}.${payload}.${signature}`;
  }

  // ── Installation token ──

  /**
   * Get a valid installation access token. Cached and auto-refreshed.
   *
   * Concurrent callers share the same in-flight refresh to avoid
   * redundant API calls.
   */
  async get_token(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expires_at - TOKEN_REFRESH_MARGIN_MS) {
      return this.cached.token;
    }

    // Coalesce concurrent refreshes
    if (this.refresh_promise) {
      return this.refresh_promise;
    }

    this.refresh_promise = this.fetch_installation_token();
    try {
      return await this.refresh_promise;
    } finally {
      this.refresh_promise = null;
    }
  }

  private async fetch_installation_token(): Promise<string> {
    const jwt = this.sign_jwt();

    const res = await fetch(
      `https://api.github.com/app/installations/${this.config.installation_id}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Failed to get installation token: ${String(res.status)} ${body}`,
      );
    }

    const data = (await res.json()) as { token: string; expires_at: string };

    this.cached = {
      token: data.token,
      expires_at: new Date(data.expires_at).getTime(),
    };

    console.log(
      `[github-app] Installation token refreshed (expires ${data.expires_at})`,
    );

    return data.token;
  }

  // ── Webhook signature verification ──

  /**
   * Verify the `X-Hub-Signature-256` header against the raw request body.
   * Uses constant-time comparison to prevent timing attacks.
   */
  verify_signature(payload: string | Buffer, signature: string): boolean {
    if (!signature.startsWith("sha256=")) {
      return false;
    }

    const expected = createHmac("sha256", this.config.webhook_secret)
      .update(payload)
      .digest("hex");

    const actual = signature.slice("sha256=".length);

    // Constant-time comparison — both must be the same length for timingSafeEqual
    if (expected.length !== actual.length) {
      return false;
    }

    return timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(actual, "hex"),
    );
  }
}

/**
 * Try to initialize GitHubAppAuth from environment variables.
 * Returns null if any required var is missing (graceful degradation).
 */
export function init_github_app_from_env(): GitHubAppAuth | null {
  const app_id = process.env["GITHUB_APP_ID"];
  const private_key = process.env["GITHUB_APP_PRIVATE_KEY"];
  const installation_id = process.env["GITHUB_APP_INSTALLATION_ID"];
  const webhook_secret = process.env["GITHUB_APP_WEBHOOK_SECRET"];

  // Normalize PEM key — env var injection can mangle newlines
  const normalized_key = private_key ? normalize_pem(private_key) : undefined;

  if (!app_id || !normalized_key || !installation_id || !webhook_secret) {
    const missing = [
      !app_id && "GITHUB_APP_ID",
      !normalized_key && "GITHUB_APP_PRIVATE_KEY",
      !installation_id && "GITHUB_APP_INSTALLATION_ID",
      !webhook_secret && "GITHUB_APP_WEBHOOK_SECRET",
    ].filter(Boolean);
    console.log(
      `[github-app] Not configured — missing env vars: ${missing.join(", ")}`,
    );
    return null;
  }

  console.log(
    `[github-app] Initialized (app_id=${app_id}, installation_id=${installation_id})`,
  );
  return new GitHubAppAuth({ app_id, private_key: normalized_key, installation_id, webhook_secret });
}

