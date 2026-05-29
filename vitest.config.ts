import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const repoRoot = __dirname;

function pkgAliases(name: string, dir: string) {
  const base = resolve(repoRoot, 'packages', dir, 'src');
  return [
    { find: new RegExp(`^${name}$`), replacement: resolve(base, 'index.ts') },
    { find: new RegExp(`^${name}/(.*)$`), replacement: resolve(base, '$1') },
  ];
}

// Temporary fallback: until Phase 3 moves core/* → @mcp/services, route
// @mcp/services subpaths to src/core/*. Listed BEFORE the real services
// alias so it wins on first match. Remove the whole block once core/*
// physically lives under packages/services/src/.
// Temporary fallbacks while later phases still hold code under src/core/*.
// Each rule is removed when the corresponding phase physically moves files.
const legacyServicesFallback = [];

export default defineConfig({
  resolve: {
    alias: [
      ...pkgAliases('@mcp/shared', 'shared'),
      ...pkgAliases('@mcp/store', 'store'),
      ...legacyServicesFallback,
      ...pkgAliases('@mcp/services', 'services'),
      ...pkgAliases('@mcp/indexer', 'indexer'),
      ...pkgAliases('@mcp/design-system', 'design-system'),
      ...pkgAliases('@mcp/code-agent', 'code-agent'),
      ...pkgAliases('@mcp/company', 'company'),
      ...pkgAliases('@mcp/company-contracts', 'company-contracts'),
      ...pkgAliases('@mcp/candidate-pipeline', 'candidate-pipeline'),
      ...pkgAliases('@mcp/orchestrator-host', 'orchestrator-host'),
      ...pkgAliases('@mcp/plugin-sdk', 'plugin-sdk'),
      ...pkgAliases('@mcp/plugin-host', 'plugin-host'),
      { find: /^@apps\/(.*)$/, replacement: resolve(repoRoot, 'apps/$1') },
    ],
  },
  test: {
    environment: 'node',
    include: [
      'src/__tests__/**/*.test.ts',
      'packages/*/src/__tests__/**/*.test.ts',
      'packages/*/src/**/__tests__/**/*.test.ts',
      'apps/*/**/__tests__/**/*.test.ts',
    ],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    isolate: true,
    pool: 'forks',
  },
});
