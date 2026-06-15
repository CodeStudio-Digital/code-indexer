/**
 * Guard: every built-in agent has a loadable mode prompt. buildSystemPrompt
 * does `loadPrompt(agentId)` for every agent except `plan` (which uses
 * plan.txt via the plan section), so a new AgentId without a matching
 * `<id>.txt` crashes the run with ENOENT. This test fails at build time
 * instead — it would have caught the missing `api.txt`.
 */
import { describe, it, expect } from 'vitest';
import { AGENTS } from '@mcp/code-agent/agents/index.js';
import { loadPrompt } from '../loader.js';

describe('agent mode prompts', () => {
  for (const id of Object.keys(AGENTS)) {
    if (id === 'plan') continue; // plan.txt is loaded via the plan section
    it(`agent "${id}" has a loadable prompt`, () => {
      expect(() => loadPrompt(id)).not.toThrow();
      expect(loadPrompt(id).length).toBeGreaterThan(0);
    });
  }
});
