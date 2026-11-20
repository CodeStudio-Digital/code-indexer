/**
 * The index half of packages/code-agent/src/core/__tests__/force-reread-contract.test.ts:
 * every index read the runner reduces declares, in the schema the real index
 * tools port publishes, the fresh-read parameter the runner tells the model
 * to pass. No database is opened.
 */
import { describe, expect, it } from 'vitest';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import { createIndexToolsPort } from '@mcp/indexer/agent-tools/port.js';
import { REDUCIBLE_READ_TOOLS } from '@mcp/code-agent/core/compaction/rolling-reduction.js';
import { freshReadParam } from '@mcp/code-agent/core/runner/guards/read-coverage.js';
import { docsTools } from '@mcp/code-agent/tools/index-docs/docs.js';

const catalog = createIndexToolsPort({ config: {} as IndexerConfig, extraTools: docsTools }).catalog();
const INDEX_READS = [...REDUCIBLE_READ_TOOLS].filter(name => name.startsWith('mcp__'));

describe('the fresh-read instruction names a real parameter of the index read that receives it', () => {
  it.each(INDEX_READS)('%s declares its fresh-read parameter as a boolean', (name) => {
    const entry = catalog.find(tool => `mcp__${tool.name}` === name);
    expect(entry, `no catalog entry for ${name}`).toBeDefined();
    const properties = (entry!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(properties[freshReadParam(name)]).toMatchObject({ type: 'boolean' });
  });
});
