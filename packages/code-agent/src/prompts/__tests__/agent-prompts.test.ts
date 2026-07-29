/**
 * Guards for the prompt layer: every built-in agent has a loadable mode
 * prompt, every standalone prompt loads, the COMPOSED system prompt never
 * ships an unresolved `{{placeholder}}`, and every `{{var}}` in base.txt is
 * actually interpolated by buildSystemPrompt.
 *
 * buildSystemPrompt does `loadPrompt(agentId)` for every agent except `plan`
 * (which uses plan.txt via the plan section), so a new AgentId without a
 * matching `<id>.txt` crashes the run with ENOENT. These tests fail at build
 * time instead — they would have caught the missing `api.txt`, a dropped
 * standalone prompt (summarizer / crash-recovery / design-system), or a
 * base.txt `{{var}}` that no caller interpolates (which the loader silently
 * renders as an empty string).
 */
import { describe, it, expect } from 'vitest';
import { AGENTS, type AgentId } from '@mcp/code-agent/agents/index.js';
import {
  appendStaticPromptSection,
  buildSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type PromptContext,
} from '@mcp/code-agent/core/system-prompt.js';
import { loadPrompt } from '../loader.js';

describe('agent mode prompts', () => {
  for (const id of Object.keys(AGENTS)) {
    if (id === 'plan') continue; // plan.txt is loaded via the plan section
    it(`agent "${id}" has a loadable prompt`, () => {
      expect(() => loadPrompt(id)).not.toThrow();
      expect(loadPrompt(id).length).toBeGreaterThan(0);
    });
  }

  // plan.txt is loaded through the plan section (not loadPrompt(agentId)), but
  // it must still exist on disk — cover it explicitly so a rename is caught.
  it('agent "plan" has a loadable prompt (via plan section)', () => {
    expect(() => loadPrompt('plan')).not.toThrow();
    expect(loadPrompt('plan').length).toBeGreaterThan(0);
  });
});

describe('standalone prompts', () => {
  // Prompts loaded OUTSIDE the buildSystemPrompt agent loop: compaction
  // summarizers (core/summarizer.ts), the crash-recovery briefing
  // (company reestablish-master route), and the Design-System blocks
  // (index.ts ds-studio + ds-consumer-prompt.ts). A rename/delete would break
  // those call sites at runtime with no other guard.
  const STANDALONE = ['summarize', 'summarize-v2', 'master-recovery', 'ds-studio', 'ds-consumer'];
  for (const name of STANDALONE) {
    it(`standalone prompt "${name}" is loadable`, () => {
      expect(() => loadPrompt(name)).not.toThrow();
      expect(loadPrompt(name).length).toBeGreaterThan(0);
    });
  }
});

describe('composed system prompt — no unresolved placeholders', () => {
  const BASE_CTX: PromptContext = {
    projectName: 'PromptTestProj',
    projectRoot: 'D:/nonexistent-prompt-test',
    os: 'win32',
    providerFamily: 'zai',
    profile: 'navigate',
    mcpAvailable: true,
    isIndexed: true,
    sessionDrive: true,
    agentLoopV2: true,
  };

  // `{{vars}}` in api.txt is an INTENTIONAL literal — it documents the API
  // request-templating syntax, not a loader interpolation slot. agentSection
  // loads mode prompts raw (no interpolate), so it reaches the composed prompt
  // verbatim and must be allow-listed here.
  const ALLOWED: Partial<Record<AgentId, RegExp[]>> = {
    api: [/\{\{vars\}\}/g],
  };

  for (const id of Object.keys(AGENTS) as AgentId[]) {
    it(`agent "${id}" composes without leftover {{placeholders}}`, () => {
      let prompt = buildSystemPrompt({ ...BASE_CTX, agentId: id, planMode: AGENTS[id].planMode });
      for (const re of ALLOWED[id] ?? []) prompt = prompt.replace(re, '');
      const leftover = prompt.match(/\{\{\w+\}\}/g);
      expect(leftover, `unresolved placeholders: ${leftover?.join(', ')}`).toBeNull();
    });
  }
});

describe('base.txt interpolation contract', () => {
  // Mirror of the keys buildSystemPrompt passes to interpolate(loadPrompt('base'), …).
  // The loader renders an unknown {{key}} as '' (empty) and only warns — so a
  // base.txt token that no caller supplies would vanish SILENTLY. This test is
  // the tripwire: any {{placeholder}} in base.txt must be in this set.
  const PROVIDED = new Set([
    'projectName',
    'projectRoot',
    'os',
    'tierHint',
    'mcpSection',
    'nativeToolsSection',
    'overlaySection',
    'subagentsSection',
    'visionSection',
    'memorySection',
    'goalLifecycleSection',
  ]);

  it('every {{placeholder}} in base.txt is supplied by buildSystemPrompt', () => {
    const base = loadPrompt('base');
    const tokens = [...base.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
    const unknown = tokens.filter((t) => !PROVIDED.has(t));
    expect(
      unknown,
      `base.txt has {{placeholders}} not interpolated by buildSystemPrompt: ${unknown.join(', ')}`,
    ).toEqual([]);
  });
});

describe('capability-aligned composition', () => {
  const BASE_CTX: PromptContext = {
    projectName: 'PromptTestProj',
    projectRoot: 'D:/nonexistent-prompt-test',
    os: 'win32',
    providerFamily: 'zai',
    profile: 'navigate',
    agentId: 'app_orchestrator',
    availableTools: new Set(['app_get_workflow', 'app_request_decision', 'app_dispatch_ready_work', 'execute_tasks']),
  };

  it('advertises the coordinator identity and its durable workflow tools', () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain('# App Studio Coordinator mode is ACTIVE');
    expect(prompt).toContain('A tool result is a continuation');
    expect(prompt).not.toMatch(/start every turn from `app_get_workflow`/i);
    expect(prompt).toContain('`execute_tasks`');
  });

  it('scopes workflow reads to user requests instead of provider continuations', () => {
    const workspacePrompt = loadPrompt('app-studio');
    expect(workspacePrompt).toContain('call `app_get_workflow` once');
    expect(workspacePrompt).toContain('MUST NOT trigger another workflow read');
    expect(workspacePrompt).not.toMatch(/start every turn/i);
  });

  it('loads the coordinator identity exactly once', () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt.split('# App Studio Coordinator mode is ACTIVE')).toHaveLength(2);
  });

  it('inserts session-fixed extensions before the dynamic boundary', () => {
    const prompt = appendStaticPromptSection(buildSystemPrompt(BASE_CTX), '# Fixed extension');
    const [prefix, suffix] = prompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(prefix).toContain('# Fixed extension');
    expect(suffix).not.toContain('# Fixed extension');
  });

  it('renders the goal lifecycle only when both transition tools exist', () => {
    const withoutGoalTools = buildSystemPrompt({
      ...BASE_CTX,
      agentId: undefined,
      availableTools: new Set(['read_file']),
    });
    expect(withoutGoalTools).not.toContain('# Goal lifecycle');
    expect(withoutGoalTools).not.toContain('create_goal');
    expect(withoutGoalTools).not.toContain('update_goal');

    const withGoalTools = buildSystemPrompt({
      ...BASE_CTX,
      agentId: undefined,
      availableTools: new Set(['create_goal', 'update_goal']),
    });
    expect(withGoalTools).toContain('# Goal lifecycle');
    expect(withGoalTools).toContain('optional durable context and telemetry');
    expect(withGoalTools).toContain('never authorize tools or block a final response');
  });
});
