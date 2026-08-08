import { describe, expect, it } from 'vitest';
import { classifyRuntimeEnv } from './disposition.js';

describe('runtime env disposition', () => {
  it('classifies confirmed dead, baked, typed, rollout and moved families', () => {
    expect(classifyRuntimeEnv('MCP_PIPELINES_TOOL_SELECTION')?.disposition).toBe('DELETE_DEAD');
    expect(classifyRuntimeEnv('CODER_NEW_COMPACTION')?.disposition).toBe('BAKE_ON');
    expect(classifyRuntimeEnv('CODER_SELF_REVIEW')?.disposition).toBe('BAKE_OFF');
    expect(classifyRuntimeEnv('CODER_STREAM_IDLE_TIMEOUT_MS')?.target).toBe('RuntimePolicy.provider');
    expect(classifyRuntimeEnv('CODER_POLICY_ENGINE_SHADOW')?.disposition).toBe('ROLLOUT_TEMP');
    expect(classifyRuntimeEnv('CODER_COMPANY_MAX_SUBORDINATES')?.disposition).toBe('MOVE_DOMAIN');
  });

  it('does not claim unrelated environment variables', () => {
    expect(classifyRuntimeEnv('OPENAI_API_KEY')).toBeNull();
  });
});
