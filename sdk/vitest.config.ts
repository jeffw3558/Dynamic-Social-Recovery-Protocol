import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The default suite runs fully offline against MockVault.
    // Live Chipotle / ZK-Email integration tests are opt-in via DSRP_LIVE=1.
    exclude: ["node_modules", "dist", "test/**/*.live.test.ts"],
  },
});
