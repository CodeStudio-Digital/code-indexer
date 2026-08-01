import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

if (process.platform !== 'win32') {
  process.stderr.write('Rust process-real Active E2E currently requires Windows.\n');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const vitest = resolve(root, 'node_modules/vitest/vitest.mjs');
const result = spawnSync(process.execPath, [
  vitest,
  'run',
  'packages/agent-runtime-host/src/__tests__/'
    + 'native-process-real-active.windows.test.ts',
], {
  cwd: root,
  env: {
    ...process.env,
    MCP_RUST_AGENT_PROCESS_REAL_E2E: '1',
  },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
