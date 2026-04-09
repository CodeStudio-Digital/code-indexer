import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Each test gets its own temp DB; isolate for safety.
    isolate: true,
    pool: 'forks',
  },
});
