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
 * standalone prompt (summarizer / crash-recovery), or a
 * base.txt `{{var}}` that no caller interpolates (which the loader silently
 * renders as an empty string).
 */
import { describe, it, expect } from 'vitest';
import { AGENTS, type AgentId } from '@mcp/code-agent/agents/index.js';
import {
  appendStaticPromptSection,
  buildSystemPrompt,
  normalizeProviderFamily,
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
  // (company reestablish-master route). A rename/delete would break
  // those call sites at runtime with no other guard.
  const STANDALONE = ['summarize', 'summarize-v2', 'summarize-v3', 'master-recovery'];
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
    agentId: 'build',
    availableTools: new Set(['read_file', 'execute_tasks']),
  };

  const reviewTools = new Set(['submit_spec', 'submit_plan', 'submit_tasks', 'task_list', 'find_tools']);

  it('publishes only the approval route available in the current mode', () => {
    const context = { ...BASE_CTX, availableTools: reviewTools };
    const build = buildSystemPrompt(context);
    expect(build).not.toMatch(/submit_plan|submit_spec|submit_tasks/);
    const revision = buildSystemPrompt({ ...context, canRevisePlan: true });
    expect(revision).toContain('revision: true');
    expect(revision).not.toMatch(/submit_spec|submit_tasks/);
    const spec = buildSystemPrompt({ ...context, specMode: true, planMode: true });
    expect(spec).toContain('# Spec mode is ACTIVE');
    expect(spec).toContain('submit_spec');
    expect(spec).not.toMatch(/# (Build|Plan) mode is ACTIVE|submit_plan|submit_tasks/);
    const plan = buildSystemPrompt({ ...context, agentId: 'plan', planMode: true });
    expect(plan).toContain('submit_plan');
    expect(plan).toContain("gate:'approve'");
    expect(plan).not.toMatch(/submit_tasks|submit_spec/);
  });

  it('explains a missing review route without inventing tools or shell checks', () => {
    const prompt = buildSystemPrompt({
      ...BASE_CTX, agentId: 'plan', planMode: true, availableTools: new Set(['find_tools']),
      verifyCommands: 'project-specific-typecheck',
    });
    expect(prompt).toContain('Plan review is unavailable');
    expect(prompt).not.toMatch(/submit_plan|submit_tasks|task_list|code_exec|project-specific-typecheck/);
  });

  it('inserts session-fixed extensions before the dynamic boundary', () => {
    const prompt = appendStaticPromptSection(buildSystemPrompt(BASE_CTX), '# Fixed extension');
    const [prefix, suffix] = prompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(prefix).toContain('# Fixed extension');
    expect(suffix).not.toContain('# Fixed extension');
  });
});

describe('lean execution contracts', () => {
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

  it('routes retrieval by intent and stops once the responsible seam is known', () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain('`mcp__search` in `auto` for discovery');
    expect(prompt).toContain('`mcp__grep_code` for exact text');
    expect(prompt).toContain('Stop searching once the responsible code and verification path are known');
    expect(prompt).not.toContain('Always prefer MCP semantic tools');
    expect(prompt).not.toContain('never grep');
  });

  it('uses plan depth for investigation rather than arbitrary output quotas', () => {
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      agentId: 'plan',
      planMode: true,
      planDepth: 'complex',
    });
    expect(prompt).toContain('Depth changes investigation, never document length');
    expect(prompt).not.toMatch(/\d[\d,.]*\+?\s+lines of markdown/i);
  });

  it('uses prepare_edit only when the change blast radius warrants it', () => {
    const prompt = buildSystemPrompt({ ...BASE_CTX, agentId: 'build' });
    expect(prompt).toContain('Use `mcp__prepare_edit` when callers/tests or a shared contract matter');
    expect(prompt).not.toContain('Before editing an existing symbol: call `mcp__prepare_edit` first');
  });

  it('keeps Git inspection tied to the task in Build mode', () => {
    const prompt = buildSystemPrompt({ ...BASE_CTX, agentId: 'build' });
    expect(prompt).toContain('only when the request needs repository state or review of changes');
    expect(prompt).toContain('Reuse the latest result for the same scope');
    expect(prompt).not.toContain('Collect final checks and diff');
  });
});

describe('public progress contract', () => {
  const BASE_CTX: PromptContext = {
    projectName: 'PromptTestProj',
    projectRoot: 'D:/nonexistent-prompt-test',
    os: 'win32',
    profile: 'navigate',
  };

  it('routes the persisted ChatGPT provider id to the Codex prompt family', () => {
    expect(normalizeProviderFamily('openai-chatgpt')).toBe('codex');
    expect(normalizeProviderFamily('CHATGPT')).toBe('codex');
  });

  it.each(['codex', 'openai', 'kimi-code', 'generic'] as const)(
    'requires concise progress updates for the %s family',
    (providerFamily) => {
      const prompt = buildSystemPrompt({ ...BASE_CTX, providerFamily });
      expect(prompt).toContain('Before substantial tools, state the immediate objective');
      expect(prompt).toContain('at least every 60 seconds');
      expect(prompt).toContain('do not narrate trivial reads or hidden reasoning');
      expect(prompt).not.toMatch(/prefer tool calls over narration/i);
    },
  );
});
