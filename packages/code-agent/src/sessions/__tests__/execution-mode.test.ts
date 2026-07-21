import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectTurnUltraKeyword, resolveSessionExecutionPolicy } from '../execution-mode.js';

describe('session execution policy', () => {
  it('keeps legacy Ultra active despite the post-migration standard default', () => {
    expect(resolveSessionExecutionPolicy('standard', ' Ultra ')).toEqual({
      ultraEnabled: true,
      reasoningEffort: 'ultra',
    });
  });

  it('uses the virtual marker when the dedicated mode is Ultra', () => {
    expect(resolveSessionExecutionPolicy('ultra', 'high')).toEqual({
      ultraEnabled: true,
      reasoningEffort: 'ultra',
    });
  });

  it('preserves a native effort in standard mode', () => {
    expect(resolveSessionExecutionPolicy('standard', ' high ')).toEqual({
      ultraEnabled: false,
      reasoningEffort: 'high',
    });
  });
});

describe('detectTurnUltraKeyword', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fires on the ultracode keyword, case-insensitive, anywhere in the message', () => {
    vi.stubEnv('CODER_ULTRA_KEYWORD', '');
    expect(detectTurnUltraKeyword('refatora isso, ultracode', false)).toBe(true);
    expect(detectTurnUltraKeyword('ULTRACODE: varre o repo', false)).toBe(true);
  });

  it('does NOT fire on bare "ultra" or words containing it', () => {
    vi.stubEnv('CODER_ULTRA_KEYWORD', '');
    expect(detectTurnUltraKeyword('liga o modo ultra', false)).toBe(false);
    expect(detectTurnUltraKeyword('ultracodex não conta', false)).toBe(false);
    expect(detectTurnUltraKeyword(undefined, false)).toBe(false);
  });

  it('is a no-op when the session is already Ultra, and honours the kill switch', () => {
    vi.stubEnv('CODER_ULTRA_KEYWORD', '');
    expect(detectTurnUltraKeyword('ultracode', true)).toBe(false);
    vi.stubEnv('CODER_ULTRA_KEYWORD', '0');
    expect(detectTurnUltraKeyword('ultracode', false)).toBe(false);
  });
});
