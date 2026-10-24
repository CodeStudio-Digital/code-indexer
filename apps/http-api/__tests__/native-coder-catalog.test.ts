import { expect, it } from 'vitest';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { nativeCoderWorkspaceAccess } from '../workers/native-coder-catalog.js';
import { execCommandTools } from '@mcp/code-agent/tools/exec-command.js';
import { interactionTools } from '@mcp/code-agent/tools/interaction.js';
import { submitPlan } from '@mcp/code-agent/tools/plan.js';
import { previewTools } from '@mcp/code-agent/tools/preview/index.js';
import { browserTools } from '@mcp/code-agent/tools/browser/tools.js';
import { dbTools } from '@mcp/code-agent/tools/db/tools.js';
import { getToolOutput } from '@mcp/code-agent/tools/tool-output.js';
import { httpRequestTool } from '@mcp/code-agent/tools/http.js';
import { apiClientTools } from '@mcp/code-agent/tools/api-client/index.js';
import { webTools } from '@mcp/code-agent/tools/web.js';
import { ragSearchDocsTool } from '@mcp/code-agent/tools/rag-search-docs.js';
import { ragReadDocTool } from '@mcp/code-agent/tools/rag-read-doc.js';
import { ragDocOutlineTool } from '@mcp/code-agent/tools/rag-doc-outline.js';
import { getDiagnostics } from '@mcp/code-agent/tools/diagnostics.js';
import { lspTools } from '@mcp/code-agent/tools/lsp.js';
import { buildMcpResourceTools } from '@mcp/code-agent/tools/mcp-resources.js';
import type { McpToolBridge } from '@mcp/code-agent/tools/mcp-bridge.js';
import { diagramTools } from '@mcp/code-agent/tools/diagram/index.js';
import { goalTools } from '@mcp/code-agent/tools/goal.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { buildCapabilityCatalogTool } from '@mcp/code-agent/tools/capability-catalog-tool.js';
import { buildFindToolsTool } from '@mcp/code-agent/tools/find-tools.js';
import { buildExpandTools } from '@mcp/code-agent/tools/expand.js';
import { buildSessionDriveTools } from '@mcp/code-agent/tools/session-drive-tools.js';
import { recallConversationTool } from '@mcp/code-agent/tools/conversation-chapters.js';
import { rememberTool, forgetMemoryTool } from '@mcp/code-agent/tools/project-memory-tools.js';
import { buildCreateSkillTool } from '@mcp/code-agent/tools/create-skill.js';
import { managePathTool } from '@mcp/code-agent/tools/manage-path.js';
import { submitSpec } from '@mcp/code-agent/tools/spec/submit-spec.js';
import { buildCodeExecTool } from '@mcp/code-agent/tools/code-exec.js';
import { internalMcpContract } from '@mcp/code-agent/tools/internal-mcp-contract.js';
import { buildSelfReviewTool } from '@mcp/code-agent/tools/self-review.js';

it('requires a sequential owned session for self-review persistence', () => {
  const tool = buildSelfReviewTool({ settingsDbHandle: {} as never, sessionStore: {} as never,
    sessionId: '10000000-0000-4000-8000-000000000042' as never, projectRoot: 'D:\\fixture' });
  expect(nativeCoderWorkspaceAccess([tool])).toBe('exclusive_write');
  for (const change of [{ source: 'mcp' as const }, { mutates: true }, { parallelSafe: true }, { effectBoundary: undefined }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('owned session control contract');
  }
});

it.each(['spawn_agent', 'resume_agent', 'request_review'])('requires owned sequential trees for %s', name => {
  const tool = { name, source: 'native', effectBoundary: 'nested', parallelSafe: false } as CoderTool;
  expect(nativeCoderWorkspaceAccess([tool])).toBe('exclusive_write');
  for (const change of [{ source: 'mcp_external' as const }, { effectBoundary: undefined }, { parallelSafe: true }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('owned tree contract');
  }
});

it('admits historical transcripts without granting workspace mutations', () => {
  const tool = { name: 'read_agent_transcript', source: 'native', mutates: false } as CoderTool;
  expect(nativeCoderWorkspaceAccess([tool])).toBe('read_only');
  expect(() => nativeCoderWorkspaceAccess([{ ...tool, mutates: true }])).toThrow('read contract');
});

it.each(['list_agents', 'list_agent_runs', 'get_agent_run', 'get_agent_result'])('admits bounded agent read %s only with trusted provenance', name => {
  const tool = { name: `mcp__${name}`, source: 'mcp', ...internalMcpContract(name),
    capabilityProvenance: { kind: 'mcp_internal', providerId: 'code-indexer', provenanceRef: 'mcp-internal:code-indexer' } } as CoderTool;
  expect(nativeCoderWorkspaceAccess([tool])).toBe('read_only');
  expect(() => nativeCoderWorkspaceAccess([{ ...tool, repeatPolicy: 'stable' }])).toThrow('fresh read contract');
  for (const change of [{ capabilityProvenance: undefined }, { parallelSafe: false }, { mutates: true }, { effectBoundary: 'control' as const }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('first-party read contract');
  }
});

it('admits document export only with its exact first-party owned write contract', () => {
  const tool = { name: 'mcp__export_docs', source: 'mcp', ...internalMcpContract('export_docs'),
    capabilityProvenance: { kind: 'mcp_internal', providerId: 'code-indexer', provenanceRef: 'mcp-internal:code-indexer' } } as CoderTool;
  expect(nativeCoderWorkspaceAccess([tool])).toBe('exclusive_write');
  for (const change of [{ effectBoundary: undefined }, { parallelSafe: true }, { riskLevel: 'read' as const }, { mutates: false }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('publication');
  }
});

it('requires an exclusive lease for a script whose child calls may mutate', () => {
  const tool = buildCodeExecTool(new ToolRegistry());
  expect(nativeCoderWorkspaceAccess([tool])).toBe('exclusive_write');
  for (const change of [{ effectBoundary: undefined }, { repeatPolicy: 'stable' as const }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('Native script');
  }
});

it('admits specification approval only with its sequential filesystem contract', () => {
  expect(nativeCoderWorkspaceAccess([submitSpec])).toBe('exclusive_write');
  for (const change of [{ mutates: true }, { parallelSafe: true }, { interactive: false }, { effectBoundary: 'control' as const }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...submitSpec, ...change }])).toThrow('specification');
  }
});

it('admits path management only with the sequential owned filesystem contract', () => {
  expect(nativeCoderWorkspaceAccess([managePathTool])).toBe('exclusive_write');
  for (const change of [{ source: 'mcp' as const }, { parallelSafe: true }, { mutates: false }, { effectBoundary: undefined }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...managePathTool, ...change }])).toThrow('path management');
  }
});

it('admits skill authoring only with its owned sequential write contract', () => {
  const tool = buildCreateSkillTool({ dbPath: 'unused', projectId: 1, registry: new ToolRegistry() });
  expect(nativeCoderWorkspaceAccess([tool])).toBe('exclusive_write');
  for (const change of [{ source: 'mcp' as const }, { parallelSafe: true }, { mutates: false }, { effectBoundary: undefined }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('skill authoring');
  }
});

it.each([rememberTool, forgetMemoryTool].map(tool => [tool.name, tool] as const))('admits %s only with the sequential owned database contract', (_name, tool) => {
  expect(nativeCoderWorkspaceAccess([tool])).toBe('exclusive_write');
  for (const change of [{ source: 'mcp' as const }, { parallelSafe: true }, { mutates: false }, { effectBoundary: undefined }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('owned mutation contract');
  }
});

it.each([...buildSessionDriveTools(), recallConversationTool].map(t => [t.name, t] as const))('admits %s with its session data contract', (_name, tool) => {
  expect(nativeCoderWorkspaceAccess([tool])).toBe(tool.mutates ? 'exclusive_write' : 'read_only');
  for (const change of [{ mutates: !tool.mutates }, { parallelSafe: !tool.parallelSafe }, { source: 'mcp' as const }, { effectBoundary: 'filesystem' as const }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('owned storage contract');
  }
});

const discoveryRegistry = new ToolRegistry();
const discoveryTools = [buildFindToolsTool(discoveryRegistry), ...buildExpandTools(),
  buildCapabilityCatalogTool({ registry: discoveryRegistry, skills: [], skillTemplateContext: {} as never })];
it.each(discoveryTools.map(t => [t.name, t] as const))('admits %s only as a sequential catalog operation', (_name, tool) => {
  expect(nativeCoderWorkspaceAccess([tool])).toBe('exclusive_write');
  for (const change of [{ mutates: true }, { parallelSafe: true }, { source: 'mcp' as const }, { effectBoundary: undefined }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('immutable catalog contract');
  }
});

it.each(goalTools.map(t => [t.name, t] as const))('admits %s only with its journal contract', (_name, tool) => {
  expect(nativeCoderWorkspaceAccess([tool])).toBe(tool.name === 'get_goal' ? 'read_only' : 'exclusive_write');
  for (const change of [{ mutates: true }, { parallelSafe: !tool.parallelSafe }, { source: 'mcp' as const }, { effectBoundary: 'filesystem' as const }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('journal contract');
  }
});

it.each(diagramTools.map(t => [t.name, t] as const))('admits %s only with its diagram contract', (_name, tool) => {
  expect(nativeCoderWorkspaceAccess([tool])).toBe(tool.mutates ? 'exclusive_write' : 'read_only');
  for (const change of [{ mutates: !tool.mutates }, { parallelSafe: !tool.parallelSafe }, { source: 'mcp' as const }, { effectBoundary: 'control' as const }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('filesystem contract');
  }
});

it.each(lspTools.map(tool => [tool.name, tool] as const))('admits %s only with owned sequential reads', (_name, tool) => {
  expect(nativeCoderWorkspaceAccess([tool])).toBe('read_only');
  for (const change of [{ source: 'mcp' as const }, { parallelSafe: true }, { mutates: true }, { effectBoundary: 'network' as const }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('owned sequential read contract');
  }
});

it('requires the read-only contract for both MCP resource operations', () => {
  for (const tool of buildMcpResourceTools({} as McpToolBridge)) {
    expect(nativeCoderWorkspaceAccess([tool])).toBe('read_only');
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, effectBoundary: 'network' }])).toThrow('bounded read contract');
  }
});

it('requires owned sequential command execution for diagnostics', () => {
  expect(nativeCoderWorkspaceAccess([getDiagnostics])).toBe('exclusive_write');
  for (const change of [{ mutates: false }, { parallelSafe: true }, { effectBoundary: undefined }, { riskLevel: 'read' as const }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...getDiagnostics, ...change }])).toThrow('owned command contract');
  }
});

it.each([ragSearchDocsTool, ragReadDocTool, ragDocOutlineTool].map(tool => [tool.name, tool] as const))('admits %s with a bounded read contract', (_name, tool) => {
  expect(nativeCoderWorkspaceAccess([tool])).toBe('read_only');
  expect(() => nativeCoderWorkspaceAccess([{ ...tool, parallelSafe: false }])).toThrow('bounded read contract');
});

it.each(webTools.map(tool => [tool.name, tool] as const))('admits %s with its public read contract', (_name, tool) => {
  expect(nativeCoderWorkspaceAccess([tool])).toBe('read_only');
  for (const change of [{ source: 'mcp' as const }, { parallelSafe: false }, { mutates: true }, { effectBoundary: 'network' as const }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('read network contract');
  }
});

it.each(apiClientTools.map(tool => [tool.name, tool] as const))('admits %s only with its project contract', (_name, tool) => {
  expect(nativeCoderWorkspaceAccess([tool])).toBe(tool.mutates ? 'exclusive_write' : 'read_only');
  for (const change of [{ source: 'mcp' as const }, { parallelSafe: !tool.parallelSafe }, { mutates: !tool.mutates }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('project control contract');
  }
});

it('admits HTTP only with an owned sequential network contract', () => {
  expect(nativeCoderWorkspaceAccess([httpRequestTool])).toBe('exclusive_write');
  for (const change of [{ source: 'mcp' as const }, { parallelSafe: true }, { mutates: false }, { effectBoundary: undefined }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...httpRequestTool, ...change }])).toThrow('physical network contract');
  }
  expect(httpRequestTool.riskOf!({ method: 'GET' })).toBe('read');
  expect(httpRequestTool.riskOf!({ method: 'POST' })).toBe('execute');
});

it('admits durable output recovery only with the exact read contract', () => {
  expect(nativeCoderWorkspaceAccess([getToolOutput])).toBe('read_only');
  for (const change of [{ source: 'mcp' as const }, { parallelSafe: false }, { mutates: true }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...getToolOutput, ...change }])).toThrow('output recovery');
  }
});

it.each(dbTools.map(tool => [tool.name, tool] as const))('admits %s only with a private database scope', (_name, tool) => {
  expect(nativeCoderWorkspaceAccess([tool])).toBe('exclusive_write');
  for (const change of [{ effectBoundary: undefined }, { parallelSafe: true }, { mutates: !tool.mutates }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('physical database contract');
  }
});

it.each([...previewTools, ...browserTools].map(tool => [tool.name, tool] as const))('admits %s only with its exact sequential physical contract', (_name, tool) => {
  expect(nativeCoderWorkspaceAccess([tool])).toBe('exclusive_write');
  for (const change of [{ source: 'mcp_external' as const }, { effectBoundary: undefined }, { parallelSafe: true }, { mutates: !tool.mutates }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('physical control contract');
  }
});

const internal: CoderTool = {
  name: 'mcp__grep_code', description: '', parameters: { type: 'object', properties: {} },
  source: 'mcp', mutates: false, parallelSafe: true, riskLevel: 'read',
  capabilityProvenance: { kind: 'mcp_internal', providerId: 'code-indexer', provenanceRef: 'mcp-internal:code-indexer' },
  handler: async () => ({ content: 'found' }),
};
it('requires a sequential control contract for human interactions', () => {
  for (const tool of [...interactionTools, submitPlan]) {
    expect(nativeCoderWorkspaceAccess([tool])).toBe('exclusive_write');
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, parallelSafe: true }])).toThrow('control contract');
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, effectBoundary: undefined }])).toThrow('control contract');
  }
});
it('accepts the internal search contract without granting a write lease', () => {
  expect(nativeCoderWorkspaceAccess([internal])).toBe('read_only');
});
it('admits MCP memory only with the first-party owned mutation contract', () => {
  const tool = { ...internal, name: 'mcp__save_memory', mutates: true, riskLevel: 'write' as const, parallelSafe: false, effectBoundary: 'database' as const };
  expect(nativeCoderWorkspaceAccess([tool])).toBe('exclusive_write');
  for (const change of [{ source: 'mcp_external' as const }, { parallelSafe: true }, { effectBoundary: undefined }, { capabilityProvenance: undefined }]) {
    expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('owned project mutation contract');
  }
});

it.each(['get_recently_modified_files', 'get_dependencies', 'get_dependents', 'get_project_overview', 'get_project_pulse', 'rag_search_docs', 'rag_read_doc', 'rag_doc_outline', 'get_costs', 'list_models', 'list_directory', 'read_file', 'get_file_skeleton', 'get_hierarchy', 'find_implementations', 'get_symbol_body', 'find_references', 'semantic_neighbors', 'trace_usage', 'prepare_edit', 'get_repo_map', 'search_memory'])(
  'admits bounded internal %s only with the first-party read contract', name => {
    const tool = { ...internal, name: 'mcp__' + name };
    expect(nativeCoderWorkspaceAccess([tool])).toBe('read_only');
    for (const change of [{ source: 'mcp_external' as const }, { parallelSafe: false }, { effectBoundary: 'control' as const }, { capabilityProvenance: undefined }]) {
      expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('first-party read contract');
    }
  },
);

it('admits only first-party persistent commands with sequential effects and read-only inspection', () => {
  expect(nativeCoderWorkspaceAccess(execCommandTools)).toBe('exclusive_write');
  expect(nativeCoderWorkspaceAccess(execCommandTools.filter(tool => tool.name === 'list_sessions'))).toBe('read_only');
  for (const tool of execCommandTools) {
    for (const change of [{ source: 'mcp_external' as const }, { mutates: !tool.mutates }, { parallelSafe: !tool.parallelSafe }]) {
      expect(() => nativeCoderWorkspaceAccess([{ ...tool, ...change }])).toThrow('ownership contract');
    }
  }
});
it.each([
  { source: 'mcp_external' as const }, { capabilityProvenance: undefined },
  { parallelSafe: undefined }, { mutates: true },
])('rejects search-name impersonation or a changed effect contract', change => {
  expect(() => nativeCoderWorkspaceAccess([{ ...internal, ...change }])).toThrow('first-party read contract');
});

it.each([{ source: 'mcp_external' as const }, { mutates: undefined }, { riskLevel: 'write' as const }])(
  'rejects skill-name impersonation or a changed read contract', change => {
    expect(() => nativeCoderWorkspaceAccess([{ ...internal, name: 'invoke_skill', source: 'native', ...change }]))
      .toThrow('knowledge tool lost its read contract');
  },
);

it('admits host-bound MCP tools and requires physical ownership for stdio', () => {
  const tool: CoderTool = { name: 'ext_fixture__write', description: '', parameters: { type: 'object', properties: {} },
    source: 'mcp_external', mutates: true, parallelSafe: false, riskLevel: 'write', effectBoundary: 'external_mcp',
    capabilityProvenance: { kind: 'mcp_external', providerId: 'mcp-external', serverId: 'fixture', provenanceRef: 'mcp-server:fixture:revision' },
    externalMcpTransport: { serverId: 'fixture', toolName: 'write', transport: 'streamable_http', catalogueRevision: 'revision' },
    handler: async () => ({ content: 'ok' }) };
  expect(nativeCoderWorkspaceAccess([tool])).toBe('exclusive_write');
  expect(nativeCoderWorkspaceAccess([{ ...tool, externalMcpTransport: { ...tool.externalMcpTransport!,
    transport: 'stdio', processTreeContained: true } }])).toBe('exclusive_write');
  for (const changed of [{ ...tool, externalMcpTransport: undefined }, { ...tool, parallelSafe: true },
    { ...tool, externalMcpTransport: { ...tool.externalMcpTransport!, transport: 'stdio' as const } },
    { ...tool, capabilityProvenance: { ...tool.capabilityProvenance!, provenanceRef: 'mcp-server:fixture:other' } }]) {
    expect(() => nativeCoderWorkspaceAccess([changed])).toThrow('does not support');
  }
});
