import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  promoteIndexReadySystemPrompt,
  type PromptContext,
} from '../system-prompt.js';

const BASE: PromptContext = {
  projectName: 'FreshProject',
  projectRoot: 'D:/fresh-project',
  os: 'win32',
  providerFamily: 'openai',
  profile: 'navigate',
  mcpAvailable: true,
  isIndexed: false,
  sessionDrive: true,
  agentLoopV2: true,
};

describe('system prompt structural readiness', () => {
  it('keeps index tools recoverable while the automatic baseline is building', () => {
    const prompt = buildSystemPrompt(BASE);

    expect(prompt).toContain('The structural index is building');
    expect(prompt).toContain('INDEX_NOT_READY');
    expect(prompt).toContain('retry semantic/graph navigation later');
    expect(prompt).not.toContain('Tools that strictly need the symbol DB were stripped');
    expect(prompt).not.toContain('ask the user to index the project via the admin panel');
  });

  it('replaces stale readiness guidance and appends the repo map idempotently', () => {
    const waiting = buildSystemPrompt(BASE);
    const repoMap = '# Repo map (top-level symbols, recent files first)\n- src/app.ts: function main';
    const ready = promoteIndexReadySystemPrompt(waiting, {
      mcpAvailable: true,
      sessionDrive: true,
      repoMap,
    });
    const retried = promoteIndexReadySystemPrompt(ready, {
      mcpAvailable: true,
      sessionDrive: true,
      repoMap,
    });

    expect(ready).not.toContain('INDEX_NOT_READY');
    expect(ready).toContain('# Code retrieval');
    expect(ready).toContain(repoMap);
    expect(retried).toBe(ready);
  });
});
