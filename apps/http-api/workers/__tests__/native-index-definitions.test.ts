/**
 * The index tools' definitions over the REAL in-process port (no database is
 * opened): what the port publishes, the access map, and the definitions the
 * model sees, primary and prefixed. Moved from apps/mcp-server when the
 * server was deleted; the server's tools/list is no longer a reference, so
 * the definitions are pinned by the fingerprint taken before E6. Since E7b
 * only `source` and the provenance kind differ from it; since E8d the four
 * agent-run reads are gone, so 25 remain.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { createIndexToolsPort } from '@mcp/indexer/agent-tools/port.js';
import { indexCoreTools } from '@mcp/indexer/agent-tools/index.js';
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { buildNativeIndexTools } from '@mcp/code-agent/tools/native-index-tools.js';
import { prefixedBridgeTools } from '@mcp/code-agent/tools/internal-mcp-exposure.js';
import { INTERNAL_MCP_ACCESS, internalMcpContract } from '@mcp/code-agent/tools/internal-mcp-contract.js';
import { stripInjectedProjectName } from '@mcp/code-agent/tools/internal-tool-schema.js';
import { docsTools } from '@mcp/code-agent/tools/index-docs/docs.js';

const CONFIG = {} as IndexerConfig;
/** Retired in E8d with the application's agent-run API. */
const RETIRED_AGENT_READS = ['list_agents', 'list_agent_runs', 'get_agent_run', 'get_agent_result'];
/** First-party names the agent never registers (application/CLI actions). */
const NEVER_REGISTERED = ['index_project', 'export_docs'];
const SERVED = ['find_implementations', 'find_references', 'get_costs', 'get_dependencies', 'get_dependents', 'get_file_skeleton',
  'get_hierarchy', 'get_project_overview', 'get_project_pulse', 'get_recently_modified_files', 'get_repo_map', 'get_symbol_body',
  'grep_code', 'list_directory', 'list_models', 'prepare_edit', 'rag_doc_outline', 'rag_read_doc', 'rag_search_docs', 'read_file',
  'save_memory', 'search', 'search_memory', 'semantic_neighbors', 'trace_usage'];
const port = createIndexToolsPort({ config: CONFIG, extraTools: docsTools });
const binding = { projectName: 'parity-main', projectRoot: 'D:/parity' };
const native = (b = binding) => buildNativeIndexTools({ port, db: {} as CodeIndexDB, binding: b });

describe('native index tools: definitions over the real port', () => {
  it('the port publishes the 25 index tools it serves, sorted by name', () => {
    expect(port.catalog().map(entry => entry.name)).toEqual(SERVED);
    for (const entry of port.catalog()) {
      expect(typeof entry.description, entry.name).toBe('string');
      expect(entry.inputSchema, entry.name).toMatchObject({ type: 'object' });
    }
  });

  it('the retired agent-run reads are neither registered nor in the access map, primary or prefixed', () => {
    const names = [...native(), ...prefixedBridgeTools(native(), 'parity_second')].map(tool => tool.name);
    for (const name of RETIRED_AGENT_READS) {
      expect(names, name).not.toContain(`mcp__${name}`);
      expect(names, name).not.toContain(`mcp__parity_second__${name}`);
      expect(Object.hasOwn(INTERNAL_MCP_ACCESS, name), name).toBe(false);
    }
  });

  it('the access map covers every first-party index tool and agrees with its declared access', () => {
    expect(Object.keys(INTERNAL_MCP_ACCESS).sort()).toEqual([...SERVED, ...NEVER_REGISTERED].sort());
    for (const tool of [...indexCoreTools, ...docsTools]) {
      const contract = internalMcpContract(tool.name);
      expect(contract.riskLevel, tool.name).toBe(tool.access);
      expect(contract.mutates, tool.name).toBe(tool.access !== 'read');
    }
  });

  it('native definitions are the port catalog, primary and prefixed', () => {
    const viaNative = native();
    const expected = [...port.catalog()].sort((a, b) => a.name.localeCompare(b.name));
    for (const [prefix, tools] of [['mcp__', viaNative], ['mcp__parity_second__', prefixedBridgeTools(viaNative, 'parity_second')]] as const) {
      expect(tools.map(tool => tool.name)).toEqual(expected.map(entry => `${prefix}${entry.name}`));
      expected.forEach((entry, i) => {
        expect(tools[i].description, entry.name).toBe(entry.description);
        expect(JSON.stringify(tools[i].parameters), entry.name)
          .toBe(JSON.stringify(stripInjectedProjectName(entry.inputSchema as unknown as JsonSchema)));
        expect(tools[i], entry.name).toMatchObject({ source: 'native', ...internalMcpContract(entry.name),
          capabilityProvenance: { kind: 'native', providerId: 'code-indexer', provenanceRef: 'index-native:code-indexer' } });
      });
    }
    expect(viaNative).toHaveLength(25);
  });

  it('apart from source and provenance kind (E7b), the definitions are byte for byte the ones fingerprinted before E6, without the four agent-run reads (E8d)', () => {
    // Put back the two values E7b changed; every other byte must match the old
    // fingerprint with the four agent-run reads taken out of it. The pre-E6
    // snapshot of 29 gave 58a304b1e5e67317babe59719e62bd0e35431926; the same
    // snapshot without those four gives the value below.
    const asBefore = (tool: CoderTool): CoderTool => {
      expect([tool.source, tool.capabilityProvenance?.kind], tool.name).toEqual(['native', 'native']);
      return { ...tool, source: 'mcp', capabilityProvenance: { ...tool.capabilityProvenance!, kind: 'mcp_internal' } };
    };
    const strip = (tools: CoderTool[]) => tools.map(asBefore).map(({ handler, ...rest }) => ({ ...rest, handlerType: typeof handler }));
    const snapshot = {
      primary: strip(native()),
      prefixed: strip(prefixedBridgeTools(native({ projectName: 'parity-second', projectRoot: 'D:/second' }), 'parity_second')),
    };
    expect(createHash('sha1').update(JSON.stringify(snapshot, null, 2)).digest('hex')).toBe('6fad55cf484b29587491fcec61cbfbd1bad16e52');
  });

  it('without the documentation readers the port publishes no rag_ tools, and neither does the native route', () => {
    const bare = createIndexToolsPort({ config: CONFIG });
    expect(bare.catalog().filter(entry => entry.name.startsWith('rag_'))).toEqual([]);
    const names = buildNativeIndexTools({ port: bare, db: {} as CodeIndexDB, binding }).map(tool => tool.name);
    expect(names.filter(name => name.includes('rag_'))).toEqual([]);
    expect(names).toHaveLength(25 - docsTools.length);
  });
});
