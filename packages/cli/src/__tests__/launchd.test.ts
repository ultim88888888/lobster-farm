import { describe, it, expect } from "vitest";
import { generate_env_sh, generate_wrapper_sh, generate_plist } from "../lib/launchd.js";

// --- generate_env_sh ---

describe("generate_env_sh", () => {
  const mock_resolver = (paths: Record<string, string>) => (name: string) =>
    paths[name] ?? null;

  it("includes PATH with directories for detected binaries", () => {
    const resolver = mock_resolver({
      bun: "/Users/test/.bun/bin/bun",
      node: "/opt/homebrew/bin/node",
      git: "/usr/bin/git",
    });

    const result = generate_env_sh({}, resolver);

    // All three binary directories should appear in PATH
    expect(result).toContain("/Users/test/.bun/bin");
    expect(result).toContain("/opt/homebrew/bin");
    expect(result).toContain("/usr/bin");
    // Should have a PATH export
    expect(result).toMatch(/^export PATH="/m);
  });

  it("deduplicates PATH entries", () => {
    // node and git both in /usr/bin — should only appear once
    const resolver = mock_resolver({
      node: "/usr/bin/node",
      git: "/usr/bin/git",
    });

    const result = generate_env_sh({}, resolver);
    const path_line = result.split("\n").find(l => l.startsWith("export PATH="))!;
    const path_value = path_line.replace('export PATH="', "").replace('"', "");
    const dirs = path_value.split(":");

    // /usr/bin should appear exactly once
    expect(dirs.filter(d => d === "/usr/bin")).toHaveLength(1);
  });

  it("includes base PATH dirs even when no binaries found", () => {
    const resolver = mock_resolver({});

    const result = generate_env_sh({}, resolver);

    expect(result).toContain("/opt/homebrew/bin");
    expect(result).toContain("/usr/local/bin");
    expect(result).toContain("/usr/bin");
    expect(result).toContain("/bin");
  });

  it("puts detected dirs before base dirs in PATH", () => {
    const resolver = mock_resolver({
      bun: "/Users/test/.bun/bin/bun",
    });

    const result = generate_env_sh({}, resolver);
    const path_line = result.split("\n").find(l => l.startsWith("export PATH="))!;
    const path_value = path_line.replace('export PATH="', "").replace('"', "");

    const bun_idx = path_value.indexOf("/Users/test/.bun/bin");
    const homebrew_idx = path_value.indexOf("/opt/homebrew/bin");
    expect(bun_idx).toBeLessThan(homebrew_idx);
  });

  it("captures BUN_INSTALL from env when present", () => {
    const resolver = mock_resolver({});
    const env = { BUN_INSTALL: "/Users/test/.bun" };

    const result = generate_env_sh(env, resolver);

    expect(result).toContain('export BUN_INSTALL="/Users/test/.bun"');
  });

  it("captures OP_SERVICE_ACCOUNT_TOKEN from env when present", () => {
    const resolver = mock_resolver({});
    const env = { OP_SERVICE_ACCOUNT_TOKEN: "ops_abc123" };

    const result = generate_env_sh(env, resolver);

    expect(result).toContain('export OP_SERVICE_ACCOUNT_TOKEN="ops_abc123"');
  });

  it("escapes shell-special characters in env var values", () => {
    const resolver = mock_resolver({});
    const env = { OP_SERVICE_ACCOUNT_TOKEN: 'token"with$pecial`chars\\here' };

    const result = generate_env_sh(env, resolver);

    // The value should be escaped so it's safe inside double quotes
    expect(result).toContain('export OP_SERVICE_ACCOUNT_TOKEN="token\\"with\\$pecial\\`chars\\\\here"');
  });

  it("omits env vars not present in process.env", () => {
    const resolver = mock_resolver({});

    const result = generate_env_sh({}, resolver);

    expect(result).not.toContain("BUN_INSTALL");
    expect(result).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
    // Should not have the env section header either
    expect(result).not.toContain("Environment variables (captured at generation time)");
  });

  it("marks not-found binaries in comments", () => {
    const resolver = mock_resolver({
      node: "/opt/homebrew/bin/node",
    });

    const result = generate_env_sh({}, resolver);

    expect(result).toContain("# node: /opt/homebrew/bin/node");
    expect(result).toContain("# bun: not found");
    expect(result).toContain("# claude: not found");
  });

  it("starts with a shebang line", () => {
    const resolver = mock_resolver({});
    const result = generate_env_sh({}, resolver);
    expect(result).toMatch(/^#!\/bin\/zsh\n/);
  });
});

// --- generate_wrapper_sh ---

describe("generate_wrapper_sh", () => {
  it("produces a valid shell script with env.sh guard", () => {
    const result = generate_wrapper_sh("/opt/homebrew/bin/node", "/path/to/daemon/index.js");

    expect(result).toMatch(/^#!\/bin\/zsh\n/);
    expect(result).toContain('source "$ENV_FILE"');
    expect(result).toContain("exit 1");
    expect(result).toContain("FATAL");
    expect(result).toContain("not found");
  });

  it("includes correct node and daemon paths in exec", () => {
    const result = generate_wrapper_sh("/opt/homebrew/bin/node", "/Users/farm/.lobsterfarm/src/packages/daemon/dist/index.js");

    expect(result).toContain('exec "/opt/homebrew/bin/node" "/Users/farm/.lobsterfarm/src/packages/daemon/dist/index.js"');
  });

  it("references env.sh in the standard location", () => {
    const result = generate_wrapper_sh("/opt/homebrew/bin/node", "/path/to/daemon/index.js");

    expect(result).toContain(".lobsterfarm/env.sh");
  });
});

// --- generate_plist ---

describe("generate_plist", () => {
  it("uses wrapper path as sole ProgramArguments entry", () => {
    const result = generate_plist(
      "/Users/farm/.lobsterfarm/bin/start-daemon.sh",
      "/Users/farm/.lobsterfarm/logs/daemon.log",
      "/Users/farm/.lobsterfarm",
    );

    expect(result).toContain("<string>/Users/farm/.lobsterfarm/bin/start-daemon.sh</string>");
    // Should be the only entry in the array — no node path, no daemon path
    const array_match = result.match(/<array>([\s\S]*?)<\/array>/);
    expect(array_match).toBeTruthy();
    const strings_in_array = array_match![1]!.match(/<string>/g);
    expect(strings_in_array).toHaveLength(1);
  });

  it("has no EnvironmentVariables section", () => {
    const result = generate_plist(
      "/Users/farm/.lobsterfarm/bin/start-daemon.sh",
      "/Users/farm/.lobsterfarm/logs/daemon.log",
      "/Users/farm/.lobsterfarm",
    );

    expect(result).not.toContain("EnvironmentVariables");
  });

  it("includes correct log paths", () => {
    const result = generate_plist(
      "/wrapper.sh",
      "/logs/daemon.log",
      "/working",
    );

    expect(result).toContain("<string>/logs/daemon.log</string>");
    // Both stdout and stderr should use the same log
    const log_matches = result.match(/<string>\/logs\/daemon\.log<\/string>/g);
    expect(log_matches).toHaveLength(2);
  });

  it("includes working directory", () => {
    const result = generate_plist(
      "/wrapper.sh",
      "/logs/daemon.log",
      "/Users/farm/.lobsterfarm",
    );

    expect(result).toContain("<key>WorkingDirectory</key>");
    expect(result).toContain("<string>/Users/farm/.lobsterfarm</string>");
  });

  it("includes KeepAlive and RunAtLoad", () => {
    const result = generate_plist("/w.sh", "/l.log", "/d");

    expect(result).toContain("<key>KeepAlive</key>");
    expect(result).toContain("<true/>");
    expect(result).toContain("<key>RunAtLoad</key>");
  });

  it("includes the correct launchd label", () => {
    const result = generate_plist("/w.sh", "/l.log", "/d");

    expect(result).toContain("com.lobsterfarm.daemon");
  });

  it("is synchronous (returns string, not Promise)", () => {
    const result = generate_plist("/w.sh", "/l.log", "/d");

    // If it were async, result would be a Promise object, not a string
    expect(typeof result).toBe("string");
    expect(result).toContain("<?xml");
  });

  it("produces valid XML structure", () => {
    const result = generate_plist("/w.sh", "/l.log", "/d");

    expect(result).toContain('<?xml version="1.0"');
    expect(result).toContain("<!DOCTYPE plist");
    expect(result).toContain('<plist version="1.0">');
    expect(result).toContain("</plist>");
  });
});
