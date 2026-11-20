/**
 * Capability descriptors of the index tools after they became native: only
 * the identity labels change (kind, capabilityId, metadataTrust); execution,
 * requirements and risk are the ones they had as 'mcp_internal'. A tool that
 * still carries the old kind (records written before) derives as it did. The
 * dashboard catalog shows them as the 'index' family.
 */
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { CoderTool } from '../tool.js';
import { deriveCapabilityDescriptor } from '../capability-catalog.js';
import { buildNativeIndexTools, NATIVE_INDEX_PROVENANCE_REF } from '../../tools/native-index-tools.js';
import { getAllKnownToolsMeta } from '../../tools/tiers.js';
import { fsTools } from '../../tools/fs.js';
import type { IndexToolsPort } from '../../ports/index-tools-port.js';

const port: IndexToolsPort = {
  catalog: () => ['search', 'get_repo_map', 'save_memory'].map(name => ({ name, description: `${name} tool.`, inputSchema: { type: 'object', properties: {} } })),
  invoke: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
};
const tools = new Map(buildNativeIndexTools({ port, db: {} as CodeIndexDB, binding: { projectName: 'p', projectRoot: tmpdir() } })
  .map(tool => [tool.name, tool]));
const legacy = (t: CoderTool): CoderTool => ({ ...t, source: 'mcp', capabilityProvenance: { ...t.capabilityProvenance!, kind: 'mcp_internal' } });

describe('index tool capability descriptors', () => {
  it.each(['mcp__search', 'mcp__save_memory', 'mcp__get_repo_map'])('%s: native identity, unchanged posture', name => {
    const now = deriveCapabilityDescriptor(tools.get(name)!);
    const before = deriveCapabilityDescriptor(legacy(tools.get(name)!));
    expect(now.descriptor.capabilityId).toBe(`cap:native:${name}`);
    expect(before.descriptor.capabilityId).toBe(`cap:mcp_internal:${name}`);
    expect(now.descriptor.source).toEqual({ kind: 'native', providerId: 'code-indexer',
      provenanceRef: NATIVE_INDEX_PROVENANCE_REF, metadataTrust: 'local' });
    expect(before.descriptor.source).toEqual({ kind: 'mcp_internal', providerId: 'code-indexer',
      provenanceRef: NATIVE_INDEX_PROVENANCE_REF, metadataTrust: 'untrusted' });
    const posture = (d: typeof now) => {
      const { capabilityId: _id, source: _source, ...rest } = d.descriptor;
      return { ...rest, optimistic: d.optimisticExternalMetadata };
    };
    expect(posture(now)).toEqual(posture(before));
  });

  it('tells index tools apart from plain native and external tools by providerId and kind', () => {
    const index = deriveCapabilityDescriptor(tools.get('mcp__search')!).descriptor.source;
    const native = deriveCapabilityDescriptor(fsTools.find(t => t.name === 'read_file')!).descriptor.source;
    const external = deriveCapabilityDescriptor({ ...tools.get('mcp__search')!, name: 'ext_srv__search', source: 'mcp_external',
      capabilityProvenance: { kind: 'mcp_external', providerId: 'mcp-external', serverId: 'srv' } }).descriptor.source;
    expect([index.kind, index.providerId]).toEqual(['native', 'code-indexer']);
    expect([native.kind, native.providerId]).toEqual(['native', 'coder-native']);
    expect([external.kind, external.providerId]).toEqual(['mcp_external', 'mcp-external']);
  });

  it('shows the index tools as the index family in the tools catalog the dashboard lists', () => {
    const meta = getAllKnownToolsMeta();
    const indexMeta = meta.filter(tool => tool.name.startsWith('mcp__'));
    expect(indexMeta.length).toBeGreaterThan(0);
    expect(indexMeta.every(tool => tool.source === 'index')).toBe(true);
    expect(meta.filter(tool => !tool.name.startsWith('mcp__')).every(tool => tool.source === 'native')).toBe(true);
  });
});
