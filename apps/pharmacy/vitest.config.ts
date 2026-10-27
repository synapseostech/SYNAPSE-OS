import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: {
    testTimeout: 20000,
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
    // FEFO suite uses node:test (see package.json test script).
    exclude: ["lib/pos/fefo.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
})
