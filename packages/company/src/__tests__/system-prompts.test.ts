import { describe, expect, it } from 'vitest';
import { buildSubordinateCompanyBlock } from '@mcp/company/system-prompts.js';

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
