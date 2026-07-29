import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@mcp\/session-storage\/(.*)$/,
        replacement: resolve(process.cwd(), 'packages/session-storage/src/$1'),
      },
      {
        find: /^@mcp\/session-storage$/,
        replacement: resolve(process.cwd(), 'packages/session-storage/src/index.ts'),
      },
      {
        find: /^@mcp\/agent-runtime-contracts\/(.*)$/,
        replacement: resolve(process.cwd(), 'packages/agent-runtime-contracts/src/$1'),
      },
      {
        find: /^@mcp\/code-agent\/(.*)$/,
        replacement: resolve(process.cwd(), 'packages/code-agent/src/$1'),
      },
      {
        find: /^@mcp\/shared\/(.*)$/,
        replacement: resolve(process.cwd(), 'packages/shared/src/$1'),
      },
      {
        find: /^@mcp\/shared$/,
        replacement: resolve(process.cwd(), 'packages/shared/src/index.ts'),
      },
    ],
  },
  test: {
    include: ['scripts/sessions-fs-migrate/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
