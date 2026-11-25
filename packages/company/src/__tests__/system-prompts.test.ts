import { describe, expect, it } from 'vitest';
import { buildMasterCompanyBlock, buildQaTeamBlock, buildSubordinateCompanyBlock } from '@mcp/company/system-prompts.js';

describe('Company autonomous lifecycle contract', () => {
  it('finishes authorized work without artificial user questions and respects unknown outcomes', () => {
    const prompt = buildMasterCompanyBlock({ roster: [], projects: [] });
    expect(prompt).not.toContain('Every phase ends with');
    expect(prompt).not.toContain('only after user confirmation');
    expect(prompt).not.toContain('wait_for_subordinates');
    expect(prompt).toContain('wakes you automatically in this chat');
    expect(prompt).toContain('configured autonomy limits and approval policy');
    expect(prompt).toContain('reconcile the original result first');
    expect(prompt).toContain('docs_list/docs_search');
  });
  it('describes executable preview QA even when no legacy Playwright role exists', () => {
    const prompt = buildQaTeamBlock([]);
    expect(prompt).toContain('executor="preview"');
    expect(prompt).toContain('qa_check_preview');
    expect(prompt).toContain('persistent run_id');
    expect(prompt).toContain('A model summary is not a test result');
    expect(prompt).toContain('executor="playwright" only');
  });
});

describe('buildSubordinateCompanyBlock', () => {
  it('keeps memory advisory and never lets it delay the deliverable', () => {
    const prompt = buildSubordinateCompanyBlock({
      role: 'qa',
      projects: [
        { id: 1, name: 'backend', rootPath: 'D:\\workspace\\backend' },
      ],
    });

    expect(prompt).toContain('use `mcp__search_memory` once when it is available');
    expect(prompt).toContain('Save only a novel fact');
    expect(prompt).toContain('Never search for a missing memory tool');
    expect(prompt).toContain('or delay the deliverable for memory work');
    expect(prompt).not.toContain('must save');
    expect(prompt).not.toContain('before posting your deliverable, search');
  });

  it('describes native slug routing when a role owns multiple projects', () => {
    const prompt = buildSubordinateCompanyBlock({
      role: 'architect',
      projects: [
        { id: 1, name: 'backend', rootPath: 'D:\\workspace\\backend' },
        { id: 2, name: 'frontend', rootPath: 'D:\\workspace\\frontend' },
      ],
    });

    expect(prompt).toContain('links every assigned project');
    expect(prompt).toContain('project-slug routing');
    expect(prompt).toContain('**backend** (id=1)');
    expect(prompt).toContain('**frontend** (id=2)');
  });

  it('makes verifier roles read-only by default and gives every role a deterministic stop rule', () => {
    const qaPrompt = buildSubordinateCompanyBlock({
      role: 'qa',
      projects: [{ id: 1, name: 'frontend', rootPath: 'D:\\workspace\\frontend' }],
    });
    const frontendPrompt = buildSubordinateCompanyBlock({
      role: 'frontend',
      projects: [{ id: 1, name: 'frontend', rootPath: 'D:\\workspace\\frontend' }],
    });

    expect(qaPrompt).toContain('Verification default');
    expect(qaPrompt).toContain('do not edit product files or create scratch artefacts');
    expect(qaPrompt).toContain('After it returns, emit one concise final sentence and stop');
    expect(qaPrompt).toContain('do not poll the board or call `set_agent_status`');
    expect(frontendPrompt).not.toContain('Verification default');
  });
});
