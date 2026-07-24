/**
 * buildVerifyEvidence only needs `.prepare(sql).all(...)` — a stub stands in
 * for better-sqlite3 (whose native binding is Electron-ABI in this repo and
 * cannot load under plain-node vitest).
 */
import { describe, it, expect } from 'vitest';
import { buildVerifyEvidence, formatVerifyEvidence } from '../review-evidence.js';

type Row = {
  args_json: string;
  result_text: string | null;
  is_error: number;
  created_at: string;
};

function stubDb(toolCalls: Row[], editedFiles: Array<{ file_path: string; applied_at: string }>) {
  return {
    prepare(sql: string) {
      if (sql.includes('coder_tool_calls')) {
        return { all: () => [...toolCalls].reverse() }; // ORDER BY id DESC
      }
      return {
        all: (_sessionId: number, after: string) =>
          editedFiles
            .filter((e) => e.applied_at >= after)
            .map((e) => ({ file_path: e.file_path, applied_at: e.applied_at })),
      };
    },
  } as unknown as Parameters<typeof buildVerifyEvidence>[0];
}

const call = (command: string, at: string, result = 'done exit=0', isError = false): Row => ({
  args_json: JSON.stringify({ command }),
  result_text: result,
  is_error: isError ? 1 : 0,
  created_at: at,
});

describe('buildVerifyEvidence', () => {
  it('finds the last verify-ish command and parses its exit code', () => {
    const db = stubDb(
      [
        call('ls -la', '2026-07-14 10:00:00'),
        call('pnpm test', '2026-07-14 10:05:00', 'suite ok exit=0'),
        call('git status', '2026-07-14 10:06:00'),
      ],
      [],
    );
    const e = buildVerifyEvidence(db, 1)!;
    expect(e.lastVerify).toMatchObject({ command: 'pnpm test', exitCode: 0 });
    expect(e.verifyCount).toBe(1);
    expect(e.filesEditedAfter).toEqual([]);
  });

  it('reports files edited AFTER the last verify run as stale', () => {
    const db = stubDb(
      [call('pnpm typecheck', '2026-07-14 10:00:00', 'exit=0')],
      [
        { file_path: 'src/before.ts', applied_at: '2026-07-14 09:59:00' },
        { file_path: 'src/after.ts', applied_at: '2026-07-14 10:01:00' },
      ],
    );
    const e = buildVerifyEvidence(db, 1)!;
    expect(e.filesEditedAfter).toEqual(['src/after.ts']);
    expect(formatVerifyEvidence(e)).toContain('STALE');
    expect(formatVerifyEvidence(e)).toContain('src/after.ts');
  });

  it('reports same-second edits as ambiguous instead of silently fresh', () => {
    const db = stubDb(
      [call('pnpm test', '2026-07-14 10:00:00', 'exit=0')],
      [{ file_path: 'src/same-second.ts', applied_at: '2026-07-14 10:00:00' }],
    );
    const e = buildVerifyEvidence(db, 1)!;
    expect(e.filesEditedAfter).toEqual([]);
    expect(e.filesEditedAtSameTime).toEqual(['src/same-second.ts']);
    expect(formatVerifyEvidence(e)).toContain('AMBIGUOUS');
    expect(formatVerifyEvidence(e)).toContain('rerun verification');
  });

  it('declares the session unverified when no verify command ran', () => {
    const e = buildVerifyEvidence(stubDb([call('ls', '2026-07-14 10:00:00')], []), 1)!;
    expect(e.lastVerify).toBeNull();
    expect(formatVerifyEvidence(e)).toContain('UNVERIFIED');
  });

  it('degrades to null on a store error instead of throwing', () => {
    const broken = {
      prepare() {
        throw new Error('no such table');
      },
    } as unknown as Parameters<typeof buildVerifyEvidence>[0];
    expect(buildVerifyEvidence(broken, 1)).toBeNull();
  });
});
