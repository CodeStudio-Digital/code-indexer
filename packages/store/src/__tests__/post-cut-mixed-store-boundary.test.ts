import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ACTIVE_MIXED_STORES = [
  'counterfactual-log-store.ts',
  'pipeline-telemetry-store.ts',
  'sub-agent-result-cache-store.ts',
  join('db', 'agent-memory.ts'),
  join('db', 'memory-distill-log.ts'),
] as const;

describe('post-cut mixed SQLite stores', () => {
  it('never reads or writes columns removed by the filesystem-session cutover', async () => {
    const root = join(process.cwd(), 'packages', 'store', 'src');
    for (const file of ACTIVE_MIXED_STORES) {
      const source = await readFile(join(root, file), 'utf8');
      expect(source, `${file} still references session_id`).not.toMatch(
        /\bsession_id\b/i,
      );
      expect(source, `${file} still references company_session_id`).not.toMatch(
        /\bcompany_session_id\b/i,
      );
    }
  });

  it('does not expose the retired SQLite Builder checkpoint store', async () => {
    const manifest = JSON.parse(
      await readFile(
        join(process.cwd(), 'packages', 'store', 'package.json'),
        'utf8',
      ),
    ) as { exports?: Record<string, unknown> };
    expect(manifest.exports?.['./db/builder-checkpoints.js']).toBeNull();
  });

  it('does not expose any retired SQLite control-plane store', async () => {
    const manifest = JSON.parse(
      await readFile(
        join(process.cwd(), 'packages', 'store', 'package.json'),
        'utf8',
      ),
    ) as { exports?: Record<string, unknown> };
    for (const module of [
      'agent-run-store',
      'capability-store',
      'command-ledger-store',
      'control-plane-store',
      'divergence-store',
      'policy-decision-store',
      'policy-grant-store',
      'projection-cursor-store',
      'runtime-journal-store',
      'runtime-projection-replay',
    ]) {
      expect(
        manifest.exports?.[`./control-plane/${module}.js`],
        module,
      ).toBeNull();
    }
    const index = await readFile(
      join(rootForStore(), 'control-plane', 'index.ts'),
      'utf8',
    );
    expect(index).not.toMatch(/\bStore\b/);
  });

  it('keeps the project investigation ledger independent from session identity', async () => {
    const root = join(process.cwd(), 'packages', 'store', 'src');
    for (const file of ['semantic-mutation-fences.ts', join('db', 'maintenance.ts')]) {
      const source = await readFile(join(root, file), 'utf8');
      expect(source).toContain('coder_investigations');
      expect(source, `${file} coupled the project ledger to a session column`)
        .not.toMatch(/\bsession_id\b/i);
    }
  });
});

function rootForStore(): string {
  return join(process.cwd(), 'packages', 'store', 'src');
}
