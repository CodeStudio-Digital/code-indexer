import { describe, it, expect } from 'vitest';
import {
  applySmartReducerDetailed,
  reduceGitLog,
  reduceGitDiff,
  reduceGrep,
  reduceRunCommand,
} from '@mcp/code-agent/core/smart-reducers.js';

/**
 * Smart reducers shape tool_result content for high-volume tools BEFORE the
 * generic head-cut. They must be deterministic (same input → same output) so
 * server-side prompt caches stay stable across turns.
 */

describe('reduceGitLog — keep newest + oldest, elide the middle', () => {
  it('passes through when content fits in cap', () => {
    const content = 'commit abc1234\nshort log\n';
    const r = reduceGitLog({ content, cap: 10_000 });
    expect(r.applied).toBe(false);
    expect(r.content).toBe(content);
  });

  it('keeps the head + tail and elides the middle when over cap', () => {
    const commits = Array.from({ length: 50 }, (_, i) =>
      `commit ${i.toString().padStart(7, '0')}aaaa\nAuthor: x\n\n    commit message ${i} ${'x'.repeat(200)}`,
    );
    const content = commits.join('\n');
    const r = reduceGitLog({ content, cap: 10_000 });
    expect(r.applied).toBe(true);
    expect(r.content.length).toBeLessThan(content.length);
    // Both ends preserved
    expect(r.content).toContain('commit message 0 ');
    expect(r.content).toContain(`commit message 49 `);
    // Some middle commit elided
    expect(r.content).toContain('elided');
  });

  it('is deterministic across calls', () => {
    const commits = Array.from({ length: 20 }, (_, i) =>
      `commit ${'a'.repeat(40)}\n    msg ${i} ${'x'.repeat(300)}`,
    ).join('\n');
    const r1 = reduceGitLog({ content: commits, cap: 2_000 });
    const r2 = reduceGitLog({ content: commits, cap: 2_000 });
    expect(r1.content).toBe(r2.content);
  });
});

describe('reduceGitDiff — preserve file headers, trim hunks per file', () => {
  it('passes through when content fits in cap', () => {
    const small = 'diff --git a/x.ts b/x.ts\nindex 1..2 100644\n@@ -1 +1 @@\n-x\n+y\n';
    const r = reduceGitDiff({ content: small, cap: 10_000 });
    expect(r.applied).toBe(false);
  });

  it('keeps every file header but trims long hunks', () => {
    const fileWithManyHunks = (name: string) =>
      `diff --git a/${name} b/${name}\nindex aaa..bbb 100644\n--- a/${name}\n+++ b/${name}\n` +
      Array.from({ length: 50 }, (_, i) => `@@ -${i * 10},5 +${i * 10},5 @@\n-old line ${i} ${'x'.repeat(40)}\n+new line ${i} ${'y'.repeat(40)}\n`).join('');
    const big = ['a.ts', 'b.ts', 'c.ts'].map(fileWithManyHunks).join('\n');
    const r = reduceGitDiff({ content: big, cap: 2_000 });
    expect(r.applied).toBe(true);
    // First file header kept
    expect(r.content).toContain('a/a.ts');
    // Marker indicating elision
    expect(r.content).toContain('hunk(s) elided');
  });
});

describe('reduceGrep — cap matches per file', () => {
  it('passes through when content fits in cap', () => {
    const small = 'foo.ts:1: hit one\nfoo.ts:2: hit two\n';
    const r = reduceGrep({ content: small, cap: 10_000 });
    expect(r.applied).toBe(false);
  });

  it('limits matches per file when over cap', () => {
    // 30 matches in one file, 1 match in another
    const dominant = Array.from({ length: 30 }, (_, i) => `dominant.ts:${i + 1}: hit ${'x'.repeat(50)}`);
    const tiny = ['other.ts:1: hello'];
    const content = [...dominant, ...tiny].join('\n');
    const r = reduceGrep({ content, cap: 1_000 });
    expect(r.applied).toBe(true);
    // The single match in `other.ts` survives — diversity preserved
    expect(r.content).toContain('other.ts:1: hello');
    // Lots of `dominant.ts` matches are elided
    expect(r.content).toContain('elided');
    // We still see at least the first few `dominant.ts` matches
    expect(r.content).toContain('dominant.ts:1:');
  });

  it('passes through lines without a path:line: prefix', () => {
    const content = 'header line\nfoo.ts:1: a\nfoo.ts:2: b\nfooter line';
    const r = reduceGrep({ content, cap: 10_000 });
    expect(r.applied).toBe(false);
    expect(r.content).toBe(content);
  });
});

describe('reduceRunCommand — keep head + tail (errors usually at the end)', () => {
  it('passes through when content fits in cap', () => {
    const r = reduceRunCommand({ content: 'short output', cap: 10_000 });
    expect(r.applied).toBe(false);
  });

  it('keeps a long output\'s head + tail', () => {
    const head = 'starting build...\n' + 'x'.repeat(2_000) + '\n';
    const middle = 'm'.repeat(20_000) + '\n';
    const tail = 'ERROR: build failed\n' + 'y'.repeat(1_000);
    const content = head + middle + tail;
    const r = reduceRunCommand({ content, cap: 5_000 });
    expect(r.applied).toBe(true);
    expect(r.content.length).toBeLessThan(content.length);
    expect(r.content).toContain('starting build');
    expect(r.content).toContain('ERROR: build failed');
    expect(r.content).toContain('elided');
  });
});

describe('applySmartReducerDetailed — registry dispatch', () => {
  it('returns content unchanged for unregistered tools', () => {
    const content = 'x'.repeat(50_000);
    expect(applySmartReducerDetailed('write_file', content, 1_000).content).toBe(content);
  });

  it('routes git_log / git_diff / grep_code / run_command to their reducers', () => {
    const log = Array.from({ length: 20 }, (_, i) => `commit ${'a'.repeat(40)}\n${'msg ' + i + ' ' + 'x'.repeat(200)}`).join('\n');
    expect(applySmartReducerDetailed('git_log', log, 2_000).content.length).toBeLessThan(log.length);

    const grep = Array.from({ length: 30 }, (_, i) => `f.ts:${i}: hit ${'x'.repeat(60)}`).join('\n');
    expect(applySmartReducerDetailed('grep_code', grep, 500).content.length).toBeLessThan(grep.length);
    // mcp__grep_code routes to the same reducer
    expect(applySmartReducerDetailed('mcp__grep_code', grep, 500).content.length).toBeLessThan(grep.length);
  });

  it('is idempotent — applying twice == applying once', () => {
    const content = Array.from({ length: 30 }, (_, i) => `f.ts:${i}: hit ${'x'.repeat(80)}`).join('\n');
    const once = applySmartReducerDetailed('grep_code', content, 1_000).content;
    const twice = applySmartReducerDetailed('grep_code', once, 1_000).content;
    expect(twice).toBe(once);
  });
});

/**
 * Per-command dispatch inside reduceRunCommand. The shell tool emits a
 * fixed envelope (`$ <cmd>` / `exit code: N` / `--- stdout ---` /
 * `--- stderr ---`); reduceRunCommand parses that and routes to a
 * command-specific reducer when it recognizes the head, falling back to
 * head/tail for unknown commands.
 */
describe('reduceRunCommand — per-command dispatch', () => {
  const envelope = (command: string, exitCode: number, stdout = '', stderr = ''): string => {
    const lines = [`$ ${command}`, `exit code: ${exitCode}`];
    if (stdout) { lines.push('--- stdout ---'); lines.push(stdout); }
    if (stderr) { lines.push('--- stderr ---'); lines.push(stderr); }
    return lines.join('\n');
  };

  it('falls back to head/tail when content does not match the envelope', () => {
    const content = 'no envelope here ' + 'x'.repeat(20_000);
    const r = reduceRunCommand({ content, cap: 1_000 });
    expect(r.applied).toBe(true);
    expect(r.content).toContain('head/tail');
  });

  it('git status (long): drops help lines and caps files per section', () => {
    const stdout = [
      'On branch main',
      'Changes not staged for commit:',
      '  (use "git add <file>..." to update what will be committed)',
      '  (use "git restore <file>..." to discard changes in working directory)',
      ...Array.from({ length: 30 }, (_, i) => `\tmodified:   src/file${i}.ts`),
      '',
      'no changes added to commit',
    ].join('\n');
    const content = envelope('git status', 0, stdout);
    const r = reduceRunCommand({ content, cap: 400 });
    expect(r.applied).toBe(true);
    expect(r.content).not.toMatch(/\(use "git add/);
    expect(r.content).toContain('more file(s)');
    expect(r.content).toContain('src/file0.ts');
    // Envelope preserved
    expect(r.content).toContain('$ git status');
    expect(r.content).toContain('exit code: 0');
  });

  it('git status (porcelain): groups by status prefix when many lines', () => {
    const stdout = [
      ...Array.from({ length: 50 }, (_, i) => ` M file${i}.ts`),
      ...Array.from({ length: 4 }, (_, i) => `?? new${i}.ts`),
    ].join('\n');
    const content = envelope('git status -s', 0, stdout);
    const r = reduceRunCommand({ content, cap: 500 });
    expect(r.applied).toBe(true);
    expect(r.content).toContain("with prefix ' M'");
    expect(r.content).toContain('new0.ts'); // small group passes through
  });

  it('git push success: distills to ref-update line', () => {
    const stderr = [
      'Enumerating objects: 5, done.',
      'Counting objects: 100% (5/5), done.',
      'Compressing objects: 100% (3/3), done.',
      'Writing objects: 100% (3/3), 300 bytes | 300.00 KiB/s, done.',
      'Total 3 (delta 1), reused 0 (delta 0)',
      'To github.com:user/repo.git',
      '   abc1234..def5678  main -> main',
    ].join('\n') + '\n' + 'x'.repeat(2_000);
    const content = envelope('git push origin main', 0, '', stderr);
    const r = reduceRunCommand({ content, cap: 500 });
    expect(r.applied).toBe(true);
    expect(r.content).toContain('To github.com');
    expect(r.content).toContain('main -> main');
    expect(r.content).not.toContain('Enumerating objects');
    expect(r.content).not.toContain('Writing objects');
  });

  it('git pull success: keeps fast-forward + update lines', () => {
    const stdout = [
      'remote: Enumerating objects: 10, done.',
      'remote: Counting objects: 100% (10/10), done.',
      'remote: Compressing objects: 100% (5/5), done.',
      'Unpacking objects: 100% (8/8), done.',
      'From github.com:user/repo',
      '   abc1234..def5678  main       -> origin/main',
      'Updating abc1234..def5678',
      'Fast-forward',
      ' src/foo.ts | 2 +-',
      ' 1 file changed, 1 insertion(+), 1 deletion(-)',
    ].join('\n') + '\n' + 'x'.repeat(2_000);
    const content = envelope('git pull', 0, stdout);
    const r = reduceRunCommand({ content, cap: 500 });
    expect(r.applied).toBe(true);
    expect(r.content).toContain('Updating abc1234');
    expect(r.content).toContain('Fast-forward');
  });

  it('git push failure: falls through to head/tail (does NOT distill)', () => {
    const stderr = 'fatal: unable to access ...\n' + 'x'.repeat(20_000) + '\nERROR: permission denied';
    const content = envelope('git push origin main', 1, '', stderr);
    const r = reduceRunCommand({ content, cap: 500 });
    expect(r.applied).toBe(true);
    // Head/tail keeps the ERROR (tail) and the head intro
    expect(r.content).toContain('fatal: unable to access');
    expect(r.content).toContain('ERROR: permission denied');
  });

  it('npm install: strips progress / braille spinners, keeps warnings + summary', () => {
    const stdout = [
      ...Array.from({ length: 30 }, () => '⠋ resolving dependencies'),
      ...Array.from({ length: 30 }, () => 'Progress: resolved 100, reused 0, downloaded 0, added 0'),
      'npm warn deprecated foo@1.0.0: use bar instead',
      'added 250 packages in 5s',
      'found 0 vulnerabilities',
    ].join('\n');
    const content = envelope('npm install', 0, stdout);
    const r = reduceRunCommand({ content, cap: 800 });
    expect(r.applied).toBe(true);
    expect(r.content).not.toContain('Progress: resolved');
    expect(r.content).not.toContain('⠋');
    expect(r.content).toContain('npm warn deprecated');
    expect(r.content).toContain('added 250 packages');
    expect(r.content).toContain('found 0 vulnerabilities');
  });

  it('pnpm install: same filtering for pnpm-specific output', () => {
    const stdout = [
      ...Array.from({ length: 50 }, () => 'Progress: resolved 500, reused 100, downloaded 5, added 0'),
      'Packages: +123 -45',
      'WARN deprecated dependency-x@1.0.0',
      'Done in 8.5s',
    ].join('\n');
    const content = envelope('pnpm install', 0, stdout);
    const r = reduceRunCommand({ content, cap: 600 });
    expect(r.applied).toBe(true);
    expect(r.content).not.toContain('Progress: resolved');
    expect(r.content).toContain('Packages: +123 -45');
    expect(r.content).toContain('WARN deprecated');
    expect(r.content).toContain('Done in 8.5s');
  });

  it('pytest failure: keeps the FAILURES section onward', () => {
    const stdout = [
      '============================= test session starts ==============================',
      ...Array.from({ length: 50 }, (_, i) => `tests/foo.py::test_${i} PASSED`),
      'tests/bar.py::test_x FAILED',
      '=================================== FAILURES ===================================',
      '________________________________ test_x ________________________________',
      '    assert 1 == 2',
      'E   AssertionError: 1 != 2',
      '=========================== short test summary info ============================',
      'FAILED tests/bar.py::test_x',
      '=================== 1 failed, 50 passed in 0.45s ====================',
    ].join('\n');
    const content = envelope('pytest', 1, stdout);
    const r = reduceRunCommand({ content, cap: 1_500 });
    expect(r.applied).toBe(true);
    expect(r.content).toContain('FAILURES');
    expect(r.content).toContain('AssertionError');
    expect(r.content).toContain('1 failed, 50 passed');
    expect(r.content).not.toContain('test_0 PASSED');
  });

  it('pytest success: keeps only final summary lines', () => {
    const stdout = [
      '============================= test session starts ==============================',
      ...Array.from({ length: 100 }, (_, i) => `tests/foo.py::test_${i} PASSED`),
      '=================== 100 passed in 0.45s ====================',
    ].join('\n');
    const content = envelope('pytest', 0, stdout);
    const r = reduceRunCommand({ content, cap: 500 });
    expect(r.applied).toBe(true);
    expect(r.content).toContain('100 passed');
    expect(r.content).not.toContain('test_0 PASSED');
  });

  it('vitest failure: keeps Failed Tests block onward', () => {
    const stdout = [
      ' ❯ tests/foo.test.ts (3) 1ms',
      ...Array.from({ length: 50 }, (_, i) => `   ✓ test_${i}`),
      ' FAIL  tests/bar.test.ts > throws on bad input',
      'AssertionError: expected to throw',
      '  at /path/to/file.test.ts:12:5',
      ' Test Files  1 failed (2)',
      '      Tests  1 failed | 50 passed (51)',
    ].join('\n');
    const content = envelope('npx vitest run', 1, stdout);
    const r = reduceRunCommand({ content, cap: 800 });
    expect(r.applied).toBe(true);
    expect(r.content).toContain('FAIL  tests/bar.test.ts');
    expect(r.content).toContain('AssertionError');
  });

  it('docker logs: collapses consecutive identical lines', () => {
    const stdout = [
      ...Array.from({ length: 50 }, (_, i) =>
        `2024-05-01T12:00:${String(i % 60).padStart(2, '0')}Z INFO request handled`,
      ),
      '2024-05-01T12:01:00Z WARN something different',
    ].join('\n');
    const content = envelope('docker logs container1', 0, stdout);
    const r = reduceRunCommand({ content, cap: 800 });
    expect(r.applied).toBe(true);
    expect(r.content).toContain('same as previous');
    expect(r.content).toContain('something different');
  });

  it('kubectl logs: same dedup logic', () => {
    const stdout = [
      ...Array.from({ length: 40 }, () => '12:00:00 INFO heartbeat ok'),
      '12:01:00 ERROR connection lost',
    ].join('\n');
    const content = envelope('kubectl logs pod-x', 0, stdout);
    const r = reduceRunCommand({ content, cap: 500 });
    expect(r.applied).toBe(true);
    expect(r.content).toContain('same as previous');
    expect(r.content).toContain('connection lost');
  });

  it('ls: keeps first 20 entries + extension breakdown when many entries', () => {
    const stdout = [
      ...Array.from({ length: 30 }, (_, i) => `file${i}.ts`),
      ...Array.from({ length: 10 }, (_, i) => `pic${i}.png`),
      'README',
    ].join('\n');
    const content = envelope('ls -1', 0, stdout);
    const r = reduceRunCommand({ content, cap: 400 });
    expect(r.applied).toBe(true);
    expect(r.content).toContain('.ts: 30');
    expect(r.content).toContain('.png: 10');
    expect(r.content).toContain('(no extension): 1');
    expect(r.content).toContain('file0.ts');
  });

  it('is deterministic — same input produces same output', () => {
    const stdout = [
      'On branch main',
      'Changes not staged for commit:',
      '  (use "git add ...")',
      ...Array.from({ length: 30 }, (_, i) => `\tmodified:   file${i}.ts`),
    ].join('\n');
    const content = envelope('git status', 0, stdout);
    const r1 = reduceRunCommand({ content, cap: 400 });
    const r2 = reduceRunCommand({ content, cap: 400 });
    expect(r1.content).toBe(r2.content);
  });

  it('is idempotent — applying twice via applySmartReducerDetailed == applying once', () => {
    const stdout = [
      'On branch main',
      'Changes not staged for commit:',
      '  (use "git add ...")',
      ...Array.from({ length: 30 }, (_, i) => `\tmodified:   file${i}.ts`),
    ].join('\n');
    const content = envelope('git status', 0, stdout);
    const once = applySmartReducerDetailed('run_command', content, 400).content;
    const twice = applySmartReducerDetailed('run_command', once, 400).content;
    expect(twice).toBe(once);
  });

  it('unknown command falls back to head/tail', () => {
    const stdout = 'starting...\n' + 'x'.repeat(20_000) + '\nERROR: unknown failure';
    const content = envelope('some-obscure-cli --flag', 1, '', stdout);
    const r = reduceRunCommand({ content, cap: 800 });
    expect(r.applied).toBe(true);
    expect(r.content).toContain('head/tail');
    expect(r.content).toContain('starting');
    expect(r.content).toContain('ERROR: unknown failure');
  });
});
