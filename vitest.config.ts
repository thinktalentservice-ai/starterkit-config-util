import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // jsdom, not node: the storage utilities are written against the real
    // `Storage` interface and secure-ls touches `localStorage` in its
    // constructor. Faking those in node would test the fake.
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
