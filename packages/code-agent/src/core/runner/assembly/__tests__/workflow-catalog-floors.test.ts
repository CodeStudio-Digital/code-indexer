/**
 * Contextual floors (preview, role, Company essentials, required pins) are
 * added on top of the workflow surface; they must not consume the budget of
 * the optional workflow groups. The provider hard limit and the model tool
 * ceiling still bound the final total.
 *
 * Fixture tools carry an explicit `catalogDescription`, so the fingerprints
 * below depend only on membership, order and serialization (the prompt-cache
 * contract), not on the authored contract prose.
 */
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { ToolRegistry } from '../../../registry.js';
import type { CoderTool, ToolContext } from '../../../tool.js';
import type { ChatProvider } from '../../../../providers/adapter.js';
import { buildTools, fingerprintTools, type BuildToolsArgs } from '../tools.js';
import { PREVIEW_WORKFLOW_FLOOR } from '../../../../tools/tool-priority.js';

const WORKFLOW = [
  'code_exec', 'find_tools', 'capability_catalog', 'expand_toolset',
  'read_file', 'mcp__read_file', 'glob', 'mcp__grep_code', 'mcp__search',
  'list_directory', 'mcp__list_directory', 'apply_patch', 'edit_file', 'write_file',
  'manage_path', 'run_command', 'exec_command', 'write_stdin', 'list_sessions', 'get_tool_output',
  'ask_user', 'decision_gate', 'task_list', 'submit_plan', 'submit_spec',
  'remember', 'recall_memory', 'recall_conversation',
  'create_chat', 'send_chat_message', 'read_chat', 'wait_chats', 'stop_chat', 'list_chats',
  'task_complete', 'execute_tasks', 'view_image', 'view_video', 'git_log', 'git_commit', 'web_fetch',
  'mcp__get_file_skeleton', 'mcp__get_symbol_body', 'mcp__prepare_edit', 'git_status', 'git_diff',
  'rag_search_docs', 'rag_read_doc', 'invoke_skill',
];
const OPTIONAL = ['mcp__prepare_edit', 'mcp__get_file_skeleton', 'mcp__get_symbol_body', 'invoke_skill'];
const PREVIEW = [...PREVIEW_WORKFLOW_FLOOR];
// Captured from the projection at 8734e2b9, before floors stopped consuming
// the optional-group budget. A change here is a prompt-cache contract change.
// E7c-2: spawn_agent/resume_agent/collect_agents can no longer be registered, so the
// registry carries the child-chat family. This projection plus those three tools
// reproduces 8734e2b9's c69d09f3685a38875e7d7b595a1752f05027b7fe: no other tool moved.
const BUILD_FINGERPRINT = '15f1b0af2fd75fde8cbdcb32f996c212200aebf8';

function tool(name: string): CoderTool {
  return { name, source: 'native', description: `${name} full description.`, catalogDescription: `${name} contract.`,
    parameters: { type: 'object', properties: { path: { type: 'string' } } }, handler: async () => ({ content: name }) };
}
function args(overrides: Partial<BuildToolsArgs> = {}): BuildToolsArgs {
  const registry = new ToolRegistry();
  registry.registerAll([...WORKFLOW, ...PREVIEW, 'preview_navigate', ...Array.from({ length: 40 }, (_, i) => `cold_${i}`)].map(tool));
  return { registry, activeTiers: new Set(['bootstrap', 'navigate']),
    provider: { name: 'openai-chatgpt', model: 'gpt-6.1-sol' } as ChatProvider,
    toolContext: { cwd: tmpdir(), projectName: 'floors',
      runner: { agentId: 'build', planMode: false } as ToolContext['runner'] }, ...overrides };
}
const names = (result: ReturnType<typeof buildTools>) => result.tools.map(t => t.name);
const withPreview = (overrides: Partial<BuildToolsArgs> = {}) =>
  args({ activeTiers: new Set(['bootstrap', 'navigate', 'preview']), ...overrides });

describe('workflow catalog contextual floors', () => {
  it('keeps the Build projection without contextual floors byte-identical', () => {
    const build = buildTools(args());
    expect(fingerprintTools(build.tools)).toBe(BUILD_FINGERPRINT);
    expect(build.tools.length).toBeLessThanOrEqual(28);
    expect(names(build)).toEqual(expect.arrayContaining(OPTIONAL));
    const noRunner = buildTools(args({ toolContext: { cwd: tmpdir(), projectName: 'floors' } }));
    expect(fingerprintTools(noRunner.tools)).toBe(BUILD_FINGERPRINT);
    const compactModel = buildTools(args({ provider: { name: 'zai', model: 'glm-4.5-flash' } as ChatProvider }));
    expect(fingerprintTools(compactModel.tools)).toBe(BUILD_FINGERPRINT);
  });

  it('adds the preview floor without dropping the optional workflow groups', () => {
    const result = buildTools(withPreview());
    expect(names(result)).toEqual(expect.arrayContaining([...PREVIEW, ...OPTIONAL]));
    expect(names(result)).not.toContain('preview_navigate');
    expect(names(result).some(n => n.startsWith('cold_'))).toBe(false);
    expect(names(result)).toEqual([...names(result)].sort((a, b) => a.localeCompare(b)));
    const base = new Set(names(buildTools(args())));
    expect(names(result).filter(n => !base.has(n)).sort()).toEqual([...PREVIEW].sort());
  });

  it('counts optional groups against the base selection when required pins are present', () => {
    const pinned = buildTools(args({ requiredPinnedTools: new Set(['cold_1', 'cold_2', 'cold_3', 'cold_4', 'cold_5']) }));
    expect(names(pinned)).toEqual(expect.arrayContaining([...OPTIONAL, 'cold_1', 'cold_5']));
  });

  it('never lets optional groups push the total past the model tool ceiling', () => {
    const result = buildTools(withPreview({ provider: { name: 'zai', model: 'glm-4.5-flash' } as ChatProvider }));
    expect(result.tools.length).toBeLessThanOrEqual(32);
    expect(names(result)).toEqual(expect.arrayContaining(PREVIEW));
  });

  it('never lets optional groups push the total past the verified provider limit', () => {
    const limited = (maxCount: number) => withPreview({
      provider: { name: 'custom', model: 'custom', toolLimits: { maxCount, source: 'test' } } as ChatProvider,
    });
    const result = buildTools(limited(31));
    expect(result.tools.length).toBeLessThanOrEqual(31);
    expect(names(result)).toEqual(expect.arrayContaining(PREVIEW));
    expect(() => buildTools(limited(25))).toThrow(/cannot fit required capabilities/);
  });
});
