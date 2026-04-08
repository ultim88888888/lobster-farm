import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests spawn real subprocesses (mock Claude scripts with sleep).
    // Default 5s is too tight on CI runners where process startup is slower.
    testTimeout: 20_000,
  },
});
