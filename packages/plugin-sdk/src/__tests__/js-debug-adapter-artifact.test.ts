import { describe, expect, it } from 'vitest';
import {
  patchJsDebugWorkerHandoff,
  WORKER_HANDOFF_ORIGINAL,
  WORKER_PAUSE_HANDLER_ORIGINAL,
} from '../../../../scripts/js-debug-adapter-artifact.mjs';

describe('js-debug Workerd compatibility patch', () => {
  it('holds the wrapper pause until source-mapped breakpoints are installed', () => {
    const patched = patchJsDebugWorkerHandoff(
      `${WORKER_HANDOFF_ORIGINAL}\n${WORKER_PAUSE_HANDLER_ORIGINAL}`,
    );

    expect(patched).toContain('mcpPrimeOnFirstDebuggerStatement');
    expect(patched).toContain('_mcpPrimeBreakpointPause');
    expect(patched).toContain('await d.resume()');
    expect(patched).not.toContain(WORKER_HANDOFF_ORIGINAL);
    expect(patched).not.toContain(WORKER_PAUSE_HANDLER_ORIGINAL);
  });

  it('fails closed when the pinned adapter layout changes', () => {
    expect(() => patchJsDebugWorkerHandoff('upstream changed')).toThrow('patch point was not found');
  });
});
