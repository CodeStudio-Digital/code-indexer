// Reproducible local tool regression: SQLite uses the repository's Electron
// ABI; process.execPath fixtures need the real Node executable. No GUI launch,
// providers, profile data, or opt-in live database integration suites.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const electron = require('electron');
const vitest = resolve(root, 'node_modules/vitest/vitest.mjs');
const nodeOnly = [
  'packages/plugin-host/src/capabilities/__tests__/exec.test.ts',
  'packages/code-agent/src/tools/__tests__/git-tools.test.ts',
  'packages/code-agent/src/tools/__tests__/worktree.test.ts',
  'src/__tests__/worktree.test.ts',
];
const groups = [
  'apps/http-api/sse/__tests__/CoderWorkerPool.test.ts',
  'packages/code-agent/src/runtime/__tests__/bounded-tool-result-data.test.ts',
  'packages/store/src/db/__tests__/schema-bootstrap.test.ts',
  'apps/http-api/server/__tests__/owned-project-index.test.ts',
  'apps/mcp-server/__tests__/tool.test.ts',
  'packages/store/src/__tests__/semantic-store.test.ts',
  'apps/http-api/server/routes/__tests__/project-indexing.routes.test.ts',
  'apps/http-api/workers/__tests__/semantic-job-queries.test.ts',
  'apps/http-api/sse/__tests__/semantic-vector-worker-client.test.ts',
  'apps/mcp-server/__tests__/agent-run-manager.test.ts',
  'apps/mcp-server/__tests__/agent-run-reads.test.ts',
  'apps/http-api/server/__tests__/owned-agent-reads.test.ts',
  'apps/http-api/sse/__tests__/worker-agent-read-calls.test.ts',
  'apps/http-api/server/__tests__/semantic-index-coordinator.test.ts',
  'packages/code-agent/src/sessions/fs-store/__tests__/fs-session-store-crud.test.ts',
  'apps/mcp-server/__tests__/save-memory.test.ts',
  'packages/code-agent/src/tools', 'packages/company/src/tools',
  'packages/docs-agent/src', 'packages/plugin-host/src',
  'packages/services/src/mini-agent', 'packages/services/src/research-browser', 'packages/db-drivers/src',
  'packages/services/src/quality/__tests__/chat-cancellation.test.ts',
  'packages/services/src/quality/__tests__/chat-retry.test.ts',
  'packages/services/src/quality/__tests__/binding-failover.test.ts',
  'packages/services/src/quality/__tests__/binding-chat-completion.test.ts',
  'packages/services/src/services/__tests__/review-session-snapshots.test.ts',
  'packages/services/src/services/__tests__/snapshot-review-pipeline.test.ts',
  'packages/services/src/services/__tests__/intent-contract.test.ts',
  'packages/services/src/services/__tests__/exporter.test.ts',
  'packages/services/src/services/__tests__/review-fates.test.ts',
  'packages/services/src/api-client', 'packages/store/src/__tests__/api-client-store.test.ts',
  'packages/api-handlers/src/db-client', 'apps/mcp-server/tools',
  'apps/electron/src/preview-window',
  'apps/electron/src/diagram-render',
  'apps/dashboard/hooks/agent-stream/__tests__/handlers-diagram-replay.test.ts',
  'apps/http-api/sse/__tests__/worker-diagram-render.test.ts',
  'packages/code-agent/src/core/__tests__/registry-cancellation.test.ts',
  'packages/code-agent/src/core/__tests__/mutation-fence.test.ts',
  'packages/code-agent/src/core/__tests__/tool-extra-user-messages.test.ts',
  'packages/code-agent/src/ports/__tests__/snapshot-recording-filesystem-port.test.ts',
  'packages/services/src/sandbox/adapters/__tests__',
  'apps/http-api/server/routes/coder/__tests__/interaction-recovery.routes.test.ts',
  'packages/session-storage/src/__tests__/entity-window.test.ts',
  'packages/session-storage/src/__tests__/atomic-file-faults.test.ts',
  'packages/session-storage/src/__tests__/atomic-file.test.ts',
  'apps/http-api/sse/__tests__/worker-memory-handlers.test.ts',
  'packages/services/src/memory/__tests__/agent-memory-writer.test.ts',
  'packages/services/src/memory/__tests__/extractor.test.ts',
  'packages/store/src/db/__tests__/agent-memory.test.ts',
  'packages/store/src/__tests__/skill-store-authoring.test.ts',
  'packages/store/src/__tests__/skill-store-summary.test.ts',
  'packages/store/src/migrations/__tests__/268_semantic_job_lookup.test.ts',
  'packages/store/src/project-db/trim/__tests__/trim.test.ts',
  'packages/store/src/project-db/__tests__/handle.test.ts',
  'packages/services/src/memory/__tests__/investigation-semantic-index.test.ts',
  'packages/code-agent/src/sessions/fs-store/__tests__/fs-session-store-operational.test.ts',
  'apps/http-api/__tests__/worker-secrets-handlers.test.ts',
  'apps/mcp-server/__tests__/server-control.test.ts',
  'apps/mcp-server/__tests__/semantic-search-client.test.ts',
  'apps/http-api/server/routes/__tests__/agent-memory-search.routes.test.ts',
  'packages/services/src/memory/__tests__/agent-memory-service.test.ts',
  'packages/indexer/src/indexer/tree-sitter/__tests__',
  'packages/indexer/src/indexer/__tests__/incremental-dispose.test.ts',
  'packages/indexer/src/indexer/__tests__/extract-cache.test.ts',
  'src/__tests__/symbols-disk-fallback.test.ts', 'src/__tests__/repo-map.test.ts',
  'src/__tests__/read-file-feature-parity.test.ts', 'src/__tests__/file-skeleton-fallback.test.ts',
  'apps/http-api/__tests__/worker-lsp-handlers.test.ts',
  'apps/http-api/__tests__/doc-navigation.test.ts',
  'apps/http-api/server/docs/__tests__',
  'apps/http-api/workers/__tests__/worker-doc-search.test.ts',
  'packages/store/src/__tests__/doc-store.test.ts',
  'src/__tests__/mcp-resources.test.ts', 'src/__tests__/mcp-server-resources.test.ts',
  'packages/shared/src/utils/__tests__/http-engine.test.ts',
  'packages/shared/src/utils/__tests__/public-web-dns.test.ts',
  'packages/shared/src/utils/__tests__/public-web-request.test.ts',
  'packages/shared/src/utils/__tests__/ssrf.test.ts',
];

function run(label, command, args, env) {
  console.log(`\n${label}`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const electronStatus = run('Tool regression (Electron ABI, isolated fixtures)', electron,
  [vitest, 'run', ...groups, ...nodeOnly.flatMap(file => ['--exclude', file]),
    '--exclude', '**/integration*.test.ts', '--maxWorkers=4'],
  { ...process.env, ELECTRON_RUN_AS_NODE: '1' });
const nodeStatus = run('Command and Git fixtures (Node)', process.execPath,
  [vitest, 'run', ...nodeOnly], process.env);
process.exitCode = electronStatus || nodeStatus;
