/**
 * Idle disposal of the shared incremental extractor. Uses resetModules +
 * dynamic import so the module-level lease picks up the test TTL, and real
 * timers with a tiny TTL (fake timers don't drive the wasm init promises).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const KEY = 'MCP_TS_IDLE_TTL_MS';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[KEY];
  vi.resetModules();
});
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('incremental shared extractor lifecycle', () => {
  it('extracts, disposes after the idle TTL, and recreates on next use', async () => {
    process.env[KEY] = '120';
    const { treeSitterSymbols, disposeSharedExtractor } = await import('../incremental.js');
    const { TreeSitterExtractor } = await import('../tree-sitter/extractor.js');
    const disposeSpy = vi.spyOn(TreeSitterExtractor.prototype, 'dispose');

    const first = await treeSitterSymbols('a.ts', 'export function alpha(x: number): number { return x; }');
    expect(first?.symbols.some((s) => s.name === 'alpha')).toBe(true);

    await sleep(400); // > TTL — lease destroys the extractor
    expect(disposeSpy).toHaveBeenCalled();

    // Transparent re-creation after idle eviction.
    const second = await treeSitterSymbols('b.ts', 'export function beta(): void {}');
    expect(second?.symbols.some((s) => s.name === 'beta')).toBe(true);

    await disposeSharedExtractor(); // manual dispose for shutdown parity
  });

  it('disposeSharedExtractor is idempotent and safe before first use', async () => {
    process.env[KEY] = '0'; // never idle-evict
    const { disposeSharedExtractor, treeSitterSymbols } = await import('../incremental.js');
    await disposeSharedExtractor(); // nothing loaded yet — no throw
    const res = await treeSitterSymbols('c.ts', 'export const N = 1;');
    expect(res?.symbols.some((s) => s.name === 'N')).toBe(true);
    await disposeSharedExtractor();
    await disposeSharedExtractor();
  });
});
