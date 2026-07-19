import { afterEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { IResearchBrowser, ResearchBrowserInvoke } from '@mcp/shared/research-browser.js';
import { setGlobalResearchBrowser } from '@mcp/code-agent/tools/browser/bridge.js';
import { browserTools } from '@mcp/code-agent/tools/browser/index.js';
import { isResearchToolAllowed } from '@mcp/code-agent/tools/browser/policy.js';

class FakeBrowser implements IResearchBrowser {
  requests: ResearchBrowserInvoke[] = [];

  async invoke(request: ResearchBrowserInvoke): Promise<unknown> {
    this.requests.push(request);
    if (request.method === 'fill') return { valueRedacted: true };
    return { page: { url: String(request.args?.url ?? 'https://example.com'), title: 'Example' } };
  }
}

const context = { cwd: 'D:\\MCP', projectName: 'MCP', sessionId: 42 } as ToolContext;
const tool = (name: string) => {
  const found = browserTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing browser tool ${name}`);
  return found;
};

afterEach(() => setGlobalResearchBrowser(null));

describe('research browser tools', () => {
  it('uses a session-scoped key and marks page output as untrusted', async () => {
    const browser = new FakeBrowser();
    setGlobalResearchBrowser(browser);

    const result = await tool('browser_open').handler({ url: 'https://example.com' }, context);

    expect(browser.requests[0]).toMatchObject({
      key: 'coder-42',
      method: 'open',
      args: { url: 'https://example.com' },
    });
    expect(result.content).toContain('External web content — untrusted');
    expect(result.isError).not.toBe(true);
  });

  it('does not echo a filled value into model-visible output', async () => {
    const browser = new FakeBrowser();
    setGlobalResearchBrowser(browser);
    const value = 'private-search-value';

    const result = await tool('browser_fill').handler({ ref: 'a1', value }, context);

    expect(browser.requests[0]?.args?.value).toBe(value);
    expect(result.content).not.toContain(value);
    expect(result.content).toContain('valueRedacted');
  });

  it('returns a clear error when the host bridge is unavailable', async () => {
    const result = await tool('browser_snapshot').handler({}, context);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/unavailable/i);
  });
});

describe('research agent execution boundary', () => {
  it.each(['write_file', 'run_command', 'git_commit', 'invoke_skill', 'post_to_board'])(
    'rejects mutating or executable tool %s',
    (name) => expect(isResearchToolAllowed({ name, source: 'native' })).toBe(false),
  );

  it('admits external MCP tools only when explicitly non-mutating', () => {
    expect(isResearchToolAllowed({ name: 'mcp__news__search', source: 'mcp_external', mutates: false })).toBe(true);
    expect(isResearchToolAllowed({ name: 'mcp__mail__send', source: 'mcp_external' })).toBe(false);
  });
});
