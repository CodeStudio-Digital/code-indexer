import { afterEach, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { isMasterAllowed } from '@mcp/company/tools/master-filter.js';
import { getReadyDocsResearchTools, installDocsDeepResearch, setGlobalDocsResearcher,
  type DocsResearchBridge } from '../bridges/docs-bridge.js';

afterEach(() => { setGlobalDocsResearcher(null); });

it('includes research before sealing and makes legacy observation idempotent', () => {
  setGlobalDocsResearcher({ runResearch: vi.fn() } as unknown as DocsResearchBridge);
  const registry = new ToolRegistry();
  registry.registerAll(getReadyDocsResearchTools());
  registry.filterInPlace(tool => isMasterAllowed(tool));
  registry.seal();
  const register = vi.spyOn(registry, 'registerAll');
  expect(registry.has('docs_deep_research')).toBe(true);
  expect(installDocsDeepResearch({ opts: { registry } })).toBe(true);
  expect(register).not.toHaveBeenCalled();
});

it('does not advertise a missing host researcher', () => {
  setGlobalDocsResearcher(null);
  expect(getReadyDocsResearchTools()).toEqual([]);
});
