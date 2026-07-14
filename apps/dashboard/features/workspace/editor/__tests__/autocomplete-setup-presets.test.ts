import { describe, expect, it } from 'vitest';
import type { EditorProbeResult } from '@mcp/api-bus';
import { AC_PRESETS, formatCompletionProbeFailure } from '../autocompleteSetupPresets.js';

describe('autocomplete setup presets', () => {
  it('uses the current public Mistral host for free Codestral keys', () => {
    const preset = AC_PRESETS.find((item) => item.id === 'codestral-free')!;
    expect(preset.provider?.base_url).toBe('https://api.mistral.ai/v1');
    expect(preset.keyUrl).toBe('https://console.mistral.ai/api-keys/');
  });

  it('reports the actual probe status without the obsolete key/host advice', () => {
    const preset = AC_PRESETS.find((item) => item.id === 'codestral-free')!;
    const probe: EditorProbeResult = {
      ok: false, verifiedForAutomatic: false,
      samples: [{ language: 'typescript', latencyMs: 10, ttftMs: null, status: 'http_404' }],
      latency: { p50: 10, p90: 10 }, message: 'Completion probe failed.',
    };
    const message = formatCompletionProbeFailure(preset, probe);
    expect(message).toContain('api.mistral.ai/v1/fim/completions');
    expect(message).not.toContain('A 401 usually');
    expect(message).not.toContain('codestral.mistral.ai');
  });
});
