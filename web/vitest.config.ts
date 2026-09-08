import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // `server-only` throws by design when imported outside a server context.
      // The policy module is server-only in production and pure in test, so the
      // guard is stubbed rather than removed from the source.
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
