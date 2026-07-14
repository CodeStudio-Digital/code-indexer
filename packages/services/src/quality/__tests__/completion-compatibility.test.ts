import { describe, expect, it } from 'vitest';
import type { ResolvedBinding } from '../../pipelines/provider-resolver.js';
import { completionBindingRevision, completionCompatibility, makeCompletionProbeStamp } from '../completion-compatibility.js';

function binding(over: Partial<ResolvedBinding> = {}): ResolvedBinding {
  return {
    pipelineName: 'editor', bindingRole: 'autocomplete', bindingId: 1,
    provider: { id: 'p', kind: 'openai', name: 'P', enabled: true } as never,
    modelId: 'gpt-chat', modelMode: '', config: {}, resolvedFrom: 'global', ...over,
  };
}

describe('completion compatibility', () => {
  it('recommends native/template FIM and gates generic chat', () => {
    expect(completionCompatibility(binding({ provider: { id: 'd', kind: 'deepseek' } as never })).suitability).toBe('native-fim');
    expect(completionCompatibility(binding({ modelId: 'qwen2.5-coder-7b' })).suitability).toBe('template-fim');
    expect(completionCompatibility(binding()).automatic).toBe(false);
    expect(completionCompatibility(binding({ config: { allow_degraded_auto: true } })).automatic).toBe(true);
  });

  it('unlocks chat only for a matching 3-prompt stamp inside the SLO', () => {
    const b = binding();
    const stamp = makeCompletionProbeStamp(b, [500, 600, 700], true);
    expect(completionCompatibility({ ...b, config: { completion_probe: stamp } }).suitability).toBe('verified-fast-chat');
    expect(completionCompatibility({ ...b, modelId: 'other', config: { completion_probe: stamp } }).automatic).toBe(false);
    expect(completionCompatibility({ ...b, config: { completion_probe: { ...stamp, p90Ms: 1600 } } }).automatic).toBe(false);
  });

  it('makes config/model changes produce a new cache/circuit revision', () => {
    const b = binding();
    expect(completionBindingRevision(b)).not.toBe(completionBindingRevision({ ...b, modelId: 'new' }));
    expect(completionBindingRevision(b)).not.toBe(completionBindingRevision({ ...b, config: { timeout_ms: 1234 } }));
  });
});
