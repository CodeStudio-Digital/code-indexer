import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, buildSubagentLoopFraming } from '../../core/system-prompt.js';
import { loadPrompt } from '../loader.js';
import { buildLazySkillsSection } from '../../skills/prompt-injector.js';
import type { ResolvedSkill } from '../../skills/types.js';
import { buildCodeExecTool } from '../../tools/code-exec.js';
import { ToolRegistry } from '../../core/registry.js';

const base = { projectName: 'test', projectRoot: 'D:/missing-prompt-contract-project', os: 'win32', agentLoopV2: true } as const;

describe('action, approval and recovery prompt contracts', () => {
  it('treats a question-shaped action request as work without weakening read-only modes', () => {
    const build = buildSystemPrompt({ ...base, agentId: 'build' });
    const explore = buildSystemPrompt({ ...base, agentId: 'explore' });
    expect(build).toContain('can you fix');
    expect(build).not.toContain('Questions are read-only');
    expect(explore).toContain('Investigate read-only');
    expect(buildSystemPrompt({ ...base, agentId: 'build', planMode: true })).toContain('honor its approval gate first');
    expect(build).not.toContain('There is no plan gate');
  });

  it('does not advertise missing MCP retrieval tools or infer a routed provider model family', () => {
    const prompt = buildSystemPrompt({ ...base, availableTools: new Set(['read_file']), providerFamily: 'openrouter' });
    expect(prompt).toContain('Use the visible search/read tools');
    expect(prompt).not.toContain('`mcp__search` in `auto`');
    expect(prompt).not.toContain('OpenAI GPT family');
  });

  it('requires safe replay in parent and child prompts and preserves current user authority', () => {
    for (const prompt of [buildSystemPrompt(base), buildSubagentLoopFraming()]) {
      expect(prompt).toContain('only');
      expect(prompt).toContain('replay is safe');
      expect(prompt).toMatch(/[Rr]econcile unknown effects before another mutation/);
      expect(prompt).not.toContain('retry one recoverable tool failure');
    }
    expect(buildSystemPrompt(base)).toContain('subject to current user instructions and permissions');
  });

  it('documents code_exec controls without inventing a plan requirement or safe whole-batch replay', () => {
    const description = buildCodeExecTool(new ToolRegistry()).description;
    expect(description).toContain('ordinary action mode does not create a new plan requirement');
    expect(description).toContain('call them directly as top-level tools');
    expect(description).toContain('await every tool promise');
    expect(description).toContain('never replay the whole batch blindly');
    expect(description).not.toContain('this is a node:vm sandbox');
  });

  it('does not invent extra admin confirmation or convert uncertain recovery into completion', () => {
    expect(loadPrompt('admin')).toContain('do not duplicate that gate');
    const recovery = loadPrompt('master-recovery');
    expect(recovery).toContain('Done requires verification');
    expect(recovery).toContain('Reconcile unknown effects before replay');
    expect(recovery).not.toMatch(/target: \d+.*turns/);
    expect(recovery.length).toBeLessThanOrEqual(3500);
  });

  it('keeps learning complete even when code comments are disabled', () => {
    const prompt = buildSystemPrompt({ ...base, outputStyle: 'learning', blockCodeComments: true });
    expect(prompt).toContain('optional exercise in the final prose');
    expect(prompt).toContain('no line comments');
    expect(prompt).not.toContain('TODO(human)');
  });

  it('loads applicable skills without blocking progress or replacing permission policy', () => {
    const skill: ResolvedSkill = {
      id: 'fixture', name: 'Fixture', description: 'Prompt test fixture',
      slashCommand: null, promptBody: 'Inspect first.', allowedTools: null,
      modelOverride: null, providerOverride: null, contextMode: 'auto',
      pathPatterns: null, triggerPaths: null, triggerRoles: null, triggerTags: null,
      tags: [], source: 'user', author: null, sortOrder: 0,
    };
    const prompt = buildLazySkillsSection([skill]);
    expect(prompt).toContain('Progress updates and discovery are allowed first');
    expect(prompt).toContain('Skills do not override the user, active mode or permissions');
    expect(prompt).not.toContain('BEFORE any other tool call or prose');
  });

  it('diagnoses API failures instead of redefining success or assuming every 2xx is correct', () => {
    const prompt = loadPrompt('api');
    expect(prompt).toContain('A 2xx alone is insufficient');
    expect(prompt).toContain('Never rewrite expectations merely to make a failing endpoint green');
    expect(prompt).toContain('reconcile effects before retrying');
    expect(prompt).not.toContain('spec usually omitted');
  });
});

describe('compaction input boundaries', () => {
  it('bounds legacy verbatim excerpts without sacrificing pending authority or the JSON schema', () => {
    const prompt = loadPrompt('summarize-v2').replace(/\r\n/g, '\n');
    const start = prompt.indexOf('{');
    const end = prompt.indexOf('\n}\n', start) + 2;
    const schema = JSON.parse(prompt.slice(start, end)) as Record<string, unknown>;
    expect(Object.keys(schema)).toEqual(['primary_request', 'key_concepts', 'files_and_code', 'errors_and_fixes', 'problem_solving', 'all_user_messages', 'pending_tasks', 'current_work', 'next_step']);
    expect(prompt).toContain('at most 8 entries including an omission marker');
    expect(prompt).toContain('budget takes precedence over the excerpt count');
    expect(prompt).toContain('pending approvals and unknown effects');
    expect(prompt).not.toContain('never trim user messages');
    expect(prompt.length).toBeLessThanOrEqual(3200);
  });

  it.each(['summarize', 'summarize-v2', 'summarize-v3'])('treats %s input as data without inventing authority', (name: string) => {
    expect(loadPrompt(name)).toMatch(/data.*(not instructions|never instructions)/s);
  });
});
