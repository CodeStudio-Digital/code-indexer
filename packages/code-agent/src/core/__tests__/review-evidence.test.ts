import { describe, it, expect } from 'vitest';
import { asSessionId } from '@mcp/session-storage';
import { buildVerifyEvidence, formatVerifyEvidence } from '../review-evidence.js';
import type { FsReviewEvidenceSource } from '../../sessions/fs-store/review-evidence-repository.js';

type Row = {
  args_json: string;
  result_text: string | null;
  is_error: number;
  created_at: string;
};

const SESSION_ID = asSessionId('00000000-0000-4000-8000-000000000001');

function stubSource(
  toolCalls: Row[],
  editedFiles: Array<{ file_path: string; applied_at: string }>,
): FsReviewEvidenceSource {
  return {
    async listReviewEvidenceToolCalls() {
      return [...toolCalls].reverse();
    },
    async listReviewEvidenceEdits() {
      return [...editedFiles];
    },
  };
}

const call = (command: string, at: string, result = 'done exit=0', isError = false): Row => ({
  args_json: JSON.stringify({ command }),
  result_text: result,
  is_error: isError ? 1 : 0,
  created_at: at,
});

describe('buildVerifyEvidence', () => {
  it('keeps prose review separate without hiding a source edit among many reports', async () => {
    const docs = Array.from({ length: 20 }, (_, i) => ({ file_path: `docs/${i}.md`, applied_at: '2026-11-11 01:01:00' }));
    const source = stubSource([call('pnpm test > check.log', '2026-11-11 01:00:00')], docs);
    const prose = (await buildVerifyEvidence(source, SESSION_ID))!;
    expect(formatVerifyEvidence(prose)).not.toContain('STALE');
    expect(formatVerifyEvidence(prose)).toContain('Review prose separately');
    const mixed = (await buildVerifyEvidence(stubSource([call('pnpm test', '2026-11-11 01:00:00')], [
      ...docs, { file_path: 'src/last.ts', applied_at: '2026-11-11 01:01:00' },
    ]), SESSION_ID))!;
    expect(formatVerifyEvidence(mixed)).toContain('STALE');
    expect(formatVerifyEvidence(mixed)).toContain('src/last.ts');
    const docsCheck = (await buildVerifyEvidence(stubSource([call('pnpm run lint:docs', '2026-11-11 01:00:00')], docs), SESSION_ID))!;
    expect(formatVerifyEvidence(docsCheck)).toContain('STALE');
  });

  it.each([
    ['$ pnpm test\nexit code: 0\nall passed', 0],
    ['$ pnpm test\nexit code: 2\nprinted exit=0', 2],
    ['session_id=abc status=running\n\nprinted exit=0', null],
    ['session_id=abc status=exited exit=1\n\nprinted exit=0', 1],
  ] as const)('reads the native receipt rather than process stdout: %s', async (result, exitCode) => {
    const evidence = (await buildVerifyEvidence(stubSource([
      call('pnpm test', '2026-07-14 10:00:00', result),
    ], []), SESSION_ID))!;
    expect(evidence.lastVerify?.exitCode).toBe(exitCode);
    if (exitCode !== 0) expect(formatVerifyEvidence(evidence)).not.toContain('covers the current state');
  });

  it('uses the same direct-command contract as live verification', async () => {
    const source = stubSource([
      call('pnpm test', '2026-07-14 10:00:00'),
      call('echo "npm test"', '2026-07-14 10:01:00'),
      call('cat build.log', '2026-07-14 10:02:00'),
      call('pytest --collect-only', '2026-07-14 10:03:00'),
    ], []);
    expect(await buildVerifyEvidence(source, SESSION_ID)).toMatchObject({
      verifyCount: 1,
      lastVerify: { command: 'pnpm test', at: '2026-07-14 10:00:00' },
    });
  });

  it('finds the last verify-ish command and parses its exit code', async () => {
    const source = stubSource(
      [
        call('ls -la', '2026-07-14 10:00:00'),
        call('pnpm test', '2026-07-14 10:05:00', 'suite ok exit=0'),
        call('git status', '2026-07-14 10:06:00'),
      ],
      [],
    );
    const e = (await buildVerifyEvidence(source, SESSION_ID))!;
    expect(e.lastVerify).toMatchObject({ command: 'pnpm test', exitCode: 0 });
    expect(e.verifyCount).toBe(1);
    expect(e.filesEditedAfter).toEqual([]);
  });

  it('reports files edited AFTER the last verify run as stale', async () => {
    const source = stubSource(
      [call('pnpm typecheck', '2026-07-14 10:00:00', 'exit=0')],
      [
        { file_path: 'src/before.ts', applied_at: '2026-07-14 09:59:00' },
        { file_path: 'src/after.ts', applied_at: '2026-07-14 10:01:00' },
      ],
    );
    const e = (await buildVerifyEvidence(source, SESSION_ID))!;
    expect(e.filesEditedAfter).toEqual(['src/after.ts']);
    expect(formatVerifyEvidence(e)).toContain('STALE');
    expect(formatVerifyEvidence(e)).toContain('src/after.ts');
  });

  it('reports same-second edits as ambiguous instead of silently fresh', async () => {
    const source = stubSource(
      [call('pnpm test', '2026-07-14 10:00:00', 'exit=0')],
      [{ file_path: 'src/same-second.ts', applied_at: '2026-07-14 10:00:00' }],
    );
    const e = (await buildVerifyEvidence(source, SESSION_ID))!;
    expect(e.filesEditedAfter).toEqual([]);
    expect(e.filesEditedAtSameTime).toEqual(['src/same-second.ts']);
    expect(formatVerifyEvidence(e)).toContain('AMBIGUOUS');
    expect(formatVerifyEvidence(e)).toContain('rerun verification');
  });

  it('declares the session unverified when no verify command ran', async () => {
    const e = (await buildVerifyEvidence(
      stubSource([call('ls', '2026-07-14 10:00:00')], []),
      SESSION_ID,
    ))!;
    expect(e.lastVerify).toBeNull();
    expect(formatVerifyEvidence(e)).toContain('UNVERIFIED');
  });

  it('degrades to null on a store error instead of throwing', async () => {
    const broken = {
      async listReviewEvidenceToolCalls() {
        throw new Error('no such table');
      },
      async listReviewEvidenceEdits() {
        return [];
      },
    } satisfies FsReviewEvidenceSource;
    await expect(buildVerifyEvidence(broken, SESSION_ID)).resolves.toBeNull();
  });
});
