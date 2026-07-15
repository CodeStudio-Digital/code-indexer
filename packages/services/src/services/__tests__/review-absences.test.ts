import { describe, it, expect } from 'vitest';
import { computeHunks } from '../snapshot-hunks.js';
import {
  detectContractChanges,
  buildAbsenceReport,
  formatAbsencesSection,
  type ReviewReferenceLookup,
} from '../review-absences.js';
import type { FileDiff } from '../session-snapshots.js';

let nextId = 1;

function makeDiff(filePath: string, before: string, after: string): FileDiff {
  return {
    baseline: {
      id: nextId++,
      filePath,
      existedBefore: true,
      oversized: false,
      status: 'active' as FileDiff['baseline']['status'],
    },
    hunks: computeHunks(before, after).map((h) => ({ ...h, decision: 'pending' as const })),
    diffDisabled: false,
    currentContent: after,
  };
}

describe('detectContractChanges', () => {
  it('detects a changed function signature', () => {
    const diff = makeDiff(
      'src/apply.ts',
      'export function applyPatch(a: string, b: string) {\n  return a + b;\n}\n',
      'export function applyPatch(a: string, b: string, c: number) {\n  return a + b + c;\n}\n',
    );
    const changes = detectContractChanges([diff]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      symbolName: 'applyPatch',
      kind: 'signature_changed',
      filePath: 'src/apply.ts',
      baselineId: diff.baseline.id,
    });
    expect(changes[0].before).toContain('(a: string, b: string)');
    expect(changes[0].after).toContain('c: number');
  });

  it('detects a removed symbol only when it is truly gone from the file', () => {
    const removed = makeDiff(
      'src/gone.ts',
      'export function legacyHelper(x: number) {\n  return x;\n}\nexport const keep = 1;\n',
      'export const keep = 1;\n',
    );
    const moved = makeDiff(
      'src/moved.ts',
      'export function movedFn(x: number) {\n  return x;\n}\nconst pad = 1;\nconst pad2 = 2;\nconst pad3 = 3;\nconst pad4 = 4;\nconst pad5 = 5;\nconst pad6 = 6;\nconst tail = 7;\n',
      'const pad = 1;\nconst pad2 = 2;\nconst pad3 = 3;\nconst pad4 = 4;\nconst pad5 = 5;\nconst pad6 = 6;\nconst tail = 7;\nexport function movedFn(x: number) {\n  return x;\n}\n',
    );
    const changes = detectContractChanges([removed, moved]);
    expect(changes.map((c) => c.symbolName)).toContain('legacyHelper');
    expect(changes.find((c) => c.symbolName === 'legacyHelper')?.kind).toBe('removed');
    // movedFn still exists in currentContent → not a removal.
    expect(changes.map((c) => c.symbolName)).not.toContain('movedFn');
  });

  it('ignores test files, unchanged signatures, and stoplisted names', () => {
    const testFile = makeDiff(
      'src/__tests__/x.test.ts',
      'function helperThing(a) { return a; }\n',
      'function helperThing(a, b) { return a + b; }\n',
    );
    const bodyOnly = makeDiff(
      'src/body.ts',
      'export function stable(a: number) {\n  return a;\n}\n',
      'export function stable(a: number) {\n  return a * 2;\n}\n',
    );
    expect(detectContractChanges([testFile, bodyOnly])).toHaveLength(0);
  });
});

describe('buildAbsenceReport', () => {
  const diff = makeDiff(
    'src/apply.ts',
    'export function applyPatch(a: string) {\n  return a;\n}\n',
    'export function applyPatch(a: string, c: number) {\n  return a + c;\n}\n',
  );
  const touched = makeDiff('src/touched.ts', 'applyPatch("x");\n', 'applyPatch("x", 1);\n');

  it('keeps only references in files NOT touched this session', async () => {
    const lookup: ReviewReferenceLookup = {
      findReferences: async () => [
        { filePath: 'src/touched.ts', line: 1, context: 'applyPatch("x", 1);' },
        { filePath: 'src/runner.ts', line: 88, context: 'applyPatch(input)' },
        { filePath: 'src\\runner.ts', line: 88, context: 'duplicate (backslash) form' },
      ],
    };
    const entries = await buildAbsenceReport([diff, touched], lookup);
    expect(entries).toHaveLength(1);
    expect(entries[0].references).toHaveLength(1);
    expect(entries[0].references[0]).toMatchObject({ filePath: 'src/runner.ts', line: 88 });
  });

  it('swallows lookup failures instead of breaking the review', async () => {
    const lookup: ReviewReferenceLookup = {
      findReferences: async () => {
        throw new Error('index down');
      },
    };
    await expect(buildAbsenceReport([diff], lookup)).resolves.toEqual([]);
  });

  it('returns nothing when every reference was touched', async () => {
    const lookup: ReviewReferenceLookup = {
      findReferences: async () => [{ filePath: 'src/touched.ts', line: 1 }],
    };
    await expect(buildAbsenceReport([diff, touched], lookup)).resolves.toEqual([]);
  });
});

describe('formatAbsencesSection', () => {
  it('renders the entry with baselineId and untouched references', async () => {
    const diff = makeDiff(
      'src/apply.ts',
      'export function applyPatch(a: string) {\n  return a;\n}\n',
      'export function applyPatch(a: string, c: number) {\n  return a + c;\n}\n',
    );
    const entries = await buildAbsenceReport([diff], {
      findReferences: async () => [{ filePath: 'src/runner.ts', line: 88, context: 'applyPatch(x)' }],
    });
    const text = formatAbsencesSection(entries)!;
    expect(text).toContain('applyPatch');
    expect(text).toContain(`baselineId=${diff.baseline.id}`);
    expect(text).toContain('src/runner.ts:88');
    expect(text).toContain('NOT touched this session');
  });

  it('returns null for an empty report', () => {
    expect(formatAbsencesSection([])).toBeNull();
  });
});
