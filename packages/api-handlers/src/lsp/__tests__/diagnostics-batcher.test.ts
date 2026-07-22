import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticsFrame } from '@mcp/api-bus';
import type { LspDiagnostic } from '@mcp/services/lsp/lsp-protocol.js';

let createServerDiagnosticsBatcher: typeof import('../diagnostics-batcher.js').createServerDiagnosticsBatcher;

beforeAll(async () => {
  vi.stubEnv('MCP_LSP_DIAG_FLUSH_MS', '250');
  ({ createServerDiagnosticsBatcher } = await import('../diagnostics-batcher.js'));
});

afterAll(() => vi.unstubAllEnvs());
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const diagnostic = (message: string, overrides: Partial<LspDiagnostic> = {}): LspDiagnostic => ({
  range: { start: { line: 0, character: 2 }, end: { line: 1, character: 4 } },
  severity: 2,
  message,
  ...overrides,
});

describe('createServerDiagnosticsBatcher', () => {
  it('coalesces latest-per-file and resolves the project root once per timed flush', () => {
    const resolveRoot = vi.fn(() => 'D:/repo');
    const publish = vi.fn<(projectId: number, frames: DiagnosticsFrame[]) => void>();
    const batcher = createServerDiagnosticsBatcher({ resolveRoot, publish });

    batcher.enqueue(41, 'D:/repo/src/a.cs', 'omnisharp', [diagnostic('old')]);
    batcher.enqueue(41, 'D:/repo/src/a.cs', 'omnisharp', [
      diagnostic('new', { severity: 1, source: 'compiler', code: 'CS1001' }),
    ]);
    batcher.enqueue(41, 'D:/repo/src/b.cs', 'omnisharp', [diagnostic('other', { severity: 4 })]);

    vi.advanceTimersByTime(249);
    expect(resolveRoot).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(resolveRoot).toHaveBeenCalledTimes(1);
    expect(resolveRoot).toHaveBeenCalledWith(41);
    expect(publish).toHaveBeenCalledTimes(1);

    const [projectId, frames] = publish.mock.calls[0]!;
    expect(projectId).toBe(41);
    expect(frames).toHaveLength(4);
    expect(frames.filter((frame) => frame.source === 'syntax')).toEqual([
      { file: 'src/a.cs', source: 'syntax', diagnostics: [] },
      { file: 'src/b.cs', source: 'syntax', diagnostics: [] },
    ]);
    expect(frames.find((frame) => frame.file === 'src/a.cs' && frame.source === 'lsp:omnisharp')).toEqual({
      file: 'src/a.cs',
      source: 'lsp:omnisharp',
      diagnostics: [{
        file: 'src/a.cs',
        range: { start: { line: 1, column: 3 }, end: { line: 2, column: 5 } },
        severity: 'error',
        message: 'new',
        source: 'compiler',
        code: 'CS1001',
      }],
    });
    expect(frames.flatMap((frame) => frame.diagnostics).map((item) => item.message)).not.toContain('old');
    expect(frames.find((frame) => frame.file === 'src/b.cs' && frame.source === 'lsp:omnisharp')?.diagnostics[0]?.severity).toBe('hint');
  });

  it('evaluates the open-file filter at flush time without changing other servers', () => {
    const open = new Set(['src/open.cs']);
    const publish = vi.fn<(projectId: number, frames: DiagnosticsFrame[]) => void>();
    const includeFile = vi.fn((_projectId: number, file: string, serverId: string) =>
      serverId !== 'omnisharp' || open.has(file));
    const batcher = createServerDiagnosticsBatcher({
      resolveRoot: () => 'D:/repo',
      includeFile,
      publish,
    });

    batcher.enqueue(41, 'D:/repo/src/open.cs', 'omnisharp', [diagnostic('open')]);
    batcher.enqueue(41, 'D:/repo/src/closed.cs', 'omnisharp', [diagnostic('closed')]);
    batcher.enqueue(41, 'D:/repo/src/other.php', 'intelephense', [diagnostic('other')]);
    open.delete('src/open.cs');
    open.add('src/closed.cs');
    batcher.flush(41);

    const frames = publish.mock.calls[0]?.[1] ?? [];
    expect(includeFile).toHaveBeenCalledTimes(3);
    expect(frames.filter((frame) => frame.source.startsWith('lsp:')).map((frame) => frame.file)).toEqual([
      'src/closed.cs',
      'src/other.php',
    ]);
    expect(frames.flatMap((frame) => frame.diagnostics).map((item) => item.message)).not.toContain('open');
  });

  it('keeps diagnostics from two Angular workspace routes isolated', () => {
    const publish = vi.fn<(projectId: number, frames: DiagnosticsFrame[]) => void>();
    const batcher = createServerDiagnosticsBatcher({
      resolveRoot: () => 'D:/repo',
      publish,
    });

    batcher.enqueue(41, 'D:/repo/src/app.ts', 'angular', [diagnostic('legacy')], 'route-v12');
    batcher.enqueue(41, 'D:/repo/src/app.ts', 'angular', [diagnostic('modern')], 'route-v21');
    batcher.flush(41);

    const frames = publish.mock.calls[0]?.[1] ?? [];
    expect(frames.find((frame) => frame.source === 'lsp:angular:route-v12')?.diagnostics[0]?.message)
      .toBe('legacy');
    expect(frames.find((frame) => frame.source === 'lsp:angular:route-v21')?.diagnostics[0]?.message)
      .toBe('modern');
  });

  it('discards queued diagnostics for a retired route without touching siblings', () => {
    const publish = vi.fn();
    const batcher = createServerDiagnosticsBatcher({
      resolveRoot: () => 'D:/repo',
      publish,
    });
    batcher.enqueue(41, 'D:/repo/src/app.ts', 'angular', [diagnostic('legacy')], 'route-v12');
    batcher.enqueue(41, 'D:/repo/src/app.ts', 'angular', [diagnostic('modern')], 'route-v21');

    batcher.discardRoute(41, 'angular', 'route-v12');
    batcher.flush(41);

    const frames = publish.mock.calls[0]?.[1] as DiagnosticsFrame[];
    expect(frames.some((frame) => frame.source === 'lsp:angular:route-v12')).toBe(false);
    expect(frames.find((frame) => frame.source === 'lsp:angular:route-v21')?.diagnostics[0]?.message)
      .toBe('modern');
  });

  it('flushes immediately at 500 pending files and cancels the scheduled timer', () => {
    const resolveRoot = vi.fn(() => 'D:/repo');
    const publish = vi.fn<(projectId: number, frames: DiagnosticsFrame[]) => void>();
    const batcher = createServerDiagnosticsBatcher({ resolveRoot, publish });

    for (let i = 0; i < 499; i++) {
      batcher.enqueue(42, `D:/repo/src/file-${i}.cs`, 'omnisharp', [diagnostic(`m${i}`)]);
    }
    expect(publish).not.toHaveBeenCalled();

    batcher.enqueue(42, 'D:/repo/src/file-499.cs', 'omnisharp', [diagnostic('m499')]);
    expect(resolveRoot).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[1]).toHaveLength(1_000);

    vi.advanceTimersByTime(250);
    expect(resolveRoot).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('flush(projectId) drains only that project and flush() drains the remainder', () => {
    const resolveRoot = vi.fn((projectId: number) => `D:/repo-${projectId}`);
    const publish = vi.fn<(projectId: number, frames: DiagnosticsFrame[]) => void>();
    const batcher = createServerDiagnosticsBatcher({ resolveRoot, publish });

    batcher.enqueue(51, 'D:/repo-51/a.cs', 'omnisharp', [diagnostic('a')]);
    batcher.enqueue(52, 'D:/repo-52/b.cs', 'omnisharp', [diagnostic('b')]);
    batcher.flush(51);
    expect(publish.mock.calls.map(([projectId]) => projectId)).toEqual([51]);

    batcher.flush();
    expect(publish.mock.calls.map(([projectId]) => projectId)).toEqual([51, 52]);
    expect(resolveRoot).toHaveBeenCalledTimes(2);
  });
});
