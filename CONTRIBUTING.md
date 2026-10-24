# Contributing to CodeStudio Desktop

## Scope

This repository owns the Electron IDE, its React dashboard, local APIs, agents, indexer, plugin platform and TypeScript agent runtime. Cloud services, the institutional website and the Unity package are separate products and must be integrated through versioned contracts rather than source imports.

## Development

```cmd
pnpm install --frozen-lockfile
pnpm run check:boundaries
pnpm exec vitest run src/__tests__/repository-boundaries.test.ts
pnpm typecheck
pnpm run check:arch
pnpm run build:all
```

Run focused tests for the area changed before the broader checks.

`pnpm typecheck` validates both the backend and the dashboard in strict mode.
For the complete local suite after preparing desktop dependencies, use
`pnpm test:workspace`. Database tests run with Electron's SQLite ABI; process
fixtures run with Node. Reports are written to `.tmp/test-workspace/` and all
fixtures use the operating system temporary directory. This avoids rebuilding
the native SQLite addon between the two groups.
The same command includes the migration/tooling Vitest suites and the build
script tests that use Node's native test runner. Browser scenarios have their
own runner: `pnpm test:visual` against an isolated dashboard test server.

## Architecture rules

- Executable entry points belong in `apps/`.
- Reusable capabilities and contracts belong in `packages/`.
- Bundled extensions belong in `extensions/`; source from other products does not.
- New code must not increase the repository-boundary baseline.
- Do not add new general-purpose code to `packages/shared`, `packages/services` or `packages/store` when a domain-specific owner exists.
- Cross-product integration uses HTTP, MCP or published/versioned contracts.

## Changes

Keep commits focused. Do not mix architecture moves, generated artifacts and unrelated functional changes. Preserve local configuration, `.mcp-indexer`, Unity validation assets and untracked work.
