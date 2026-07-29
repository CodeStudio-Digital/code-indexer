import { describe, it, expect } from 'vitest';
import { computeHunks } from '../snapshot-hunks.js';
import { renderReviewPayload } from '../review-payload.js';
import type { FileDiff } from '../session-snapshots.js';

let nextId = 1;

function makeDiff(
  filePath: string,
  before: string,
  after: string,
): FileDiff<string> {
  const id = `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
  return {
    baseline: {
      id,
      filePath,
      existedBefore: true,
      oversized: false,
      status: 'active' as FileDiff<string>['baseline']['status'],
    },
    hunks: computeHunks(before, after).map((h) => ({ ...h, decision: 'pending' as const })),
    diffDisabled: false,
    currentContent: after,
  };
}

describe('renderReviewPayload', () => {
  it('orders chapters by dependency: imported file first, importer after', () => {
    const util = makeDiff('src/util.ts', 'export const N = 1;\n', 'export const N = 2;\n');
    const app = makeDiff(
      'src/app.ts',
      "import { N } from './util.js';\nconsole.log(N);\n",
      "import { N } from './util.js';\nconsole.log(N + 1);\n",
    );
    // Incoming order has the importer FIRST — the payload must flip it.
    const { text } = renderReviewPayload([app, util]);
    const iUtil = text.indexOf('CHAPTER 1/2: src/util.ts');
    const iApp = text.indexOf('CHAPTER 2/2: src/app.ts');
    expect(iUtil).toBeGreaterThanOrEqual(0);
    expect(iApp).toBeGreaterThan(iUtil);
    expect(text).toContain('[uses: ch.1]');
  });

  it('elides mechanical hunks to one line but keeps their anchors', () => {
    const before = 'const a=1;\nconst b=2;\n';
    const after = 'const a = 1;\nconst b = 2;\n';
    const diff = makeDiff('src/fmt.ts', before, after);
    const { text, pendingHunks } = renderReviewPayload([diff]);
    expect(pendingHunks).toBe(1);
    expect(text).toContain('MECHANICAL');
    expect(text).toContain('kind=formatting_only');
    expect(text).toContain(`hunkFingerprint=${diff.hunks[0].fingerprint}`);
    expect(text).toContain(`baselineId=${diff.baseline.id}`);
    // The body itself is gone.
    expect(text).not.toContain('const a = 1;');
    // Elision is declared, not silent.
    expect(text).toContain('BUDGET');
  });

  it('renders logic hunks in full with numbered lines', () => {
    const diff = makeDiff('src/logic.ts', 'if (a && b) run();\n', 'if (a || b) run();\n');
    const { text } = renderReviewPayload([diff]);
    expect(text).toContain('-if (a && b) run();');
    expect(text).toContain('+if (a || b) run();');
  });

  it('degrades test hunks before logic when over budget, and declares it', () => {
    const bigTestBody = Array.from({ length: 200 }, (_, i) => `expect(v${i}).toBe(${i});`).join('\n');
    const testDiff = makeDiff('src/__tests__/big.test.ts', 'old();\n', `${bigTestBody}\n`);
    const logicDiff = makeDiff('src/core.ts', 'return a;\n', 'return a ?? fallback;\n');
    const full = renderReviewPayload([testDiff, logicDiff]);
    const capped = renderReviewPayload([testDiff, logicDiff], { maxChars: full.text.length - 2_000 });
    // Logic hunk survives intact; the test hunk got trimmed and is declared.
    expect(capped.text).toContain('+return a ?? fallback;');
    expect(capped.text).toContain('trimmed');
    expect(capped.text).toContain('BUDGET');
    expect(capped.text.length).toBeLessThan(full.text.length);
  });

  it('keeps the payload within budget even when logic hunks alone exceed it', () => {
    const diffs = Array.from({ length: 6 }, (_, i) =>
      makeDiff(
        `src/f${i}.ts`,
        'old();\n',
        Array.from({ length: 120 }, (_, j) => `line${j}(${i});`).join('\n') + '\n',
      ),
    );
    const { text } = renderReviewPayload(diffs, { maxChars: 5_000 });
    // Second degradation wave (logic → summary) + declared hard cap bound it.
    expect(text.length).toBeLessThanOrEqual(5_000 + 2_000 + 200);
    expect(text).toContain('BUDGET');
  });

  it('drops dependency edges on ambiguous extensionless keys instead of guessing', () => {
    const tsx = makeDiff('src/Button.tsx', 'export const B = 1;\n', 'export const B = 2;\n');
    const css = makeDiff('src/Button.css', '.b { color: red }\n', '.b { color: blue }\n');
    const user = makeDiff(
      'src/App.tsx',
      "import { B } from './Button';\nrender(B);\n",
      "import { B } from './Button';\nrender(B + 1);\n",
    );
    const { text } = renderReviewPayload([user, tsx, css]);
    // Ambiguous './Button' → no [uses] edge at all (wrong edge would be worse).
    expect(text).not.toContain('[uses:');
  });

  it('notes diff-disabled files as their own chapter', () => {
    const diff = makeDiff('src/bin.dat', 'a\n', 'b\n');
    diff.diffDisabled = true;
    diff.hunks = [];
    const { text, pendingHunks } = renderReviewPayload([diff]);
    expect(pendingHunks).toBe(0);
    expect(text).toContain('diff disabled');
  });

  it('counts pending hunks only (kept/reverted are excluded)', () => {
    // Changes must sit further apart than the diff context (3+3 lines) or
    // computeHunks merges them into a single hunk.
    const gap = Array.from({ length: 10 }, (_, i) => `pad${i}();`).join('\n');
    const diff = makeDiff('src/x.ts', `a();\n${gap}\nmid();\n`, `a2();\n${gap}\nmid2();\n`);
    expect(diff.hunks.length).toBeGreaterThan(1);
    diff.hunks[0] = { ...diff.hunks[0], decision: 'kept' };
    const { pendingHunks } = renderReviewPayload([diff]);
    expect(pendingHunks).toBe(diff.hunks.length - 1);
  });
});
