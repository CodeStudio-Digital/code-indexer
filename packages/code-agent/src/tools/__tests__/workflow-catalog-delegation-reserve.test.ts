/**
 * The delegation reserve: a session that can delegate (root or child,
 * create_chat authorized) budgets the optional groups as if its delegation
 * and chat tools took the 3 slots of spawn_agent, resume_agent and
 * collect_agents, so the groups are those the old trio left room for, at
 * every budget; a session that cannot delegate, Company included (it never
 * has create_chat), counts the tools it has.
 */
import { describe, expect, it } from 'vitest';
import type { CoderTool } from '../../core/tool.js';
import { CHILD_CHAT_TOOL_NAMES } from '../chat-tool-set.js';
import { DELEGATION_FAMILY, DELEGATION_RESERVE_SLOTS, selectWorkflowCatalog } from '../workflow-catalog.js';
import { profileToTiers } from '../tiers.js';
import { loadChildAgentRun } from '../../runtime/child-agent-run.js';
import { scenarioRegistry } from './catalog-registry-fixture.js';

const stub = (name: string, extra: Partial<CoderTool> = {}): CoderTool =>
  ({ name, description: name, source: 'native', parameters: { type: 'object', properties: {} }, handler: async () => ({ content: '' }), ...extra });
const top = (name: string) => stub(name, { topLevelOnly: true });
const CORE = ['find_tools', 'code_exec', 'glob', 'mcp__grep_code', 'mcp__search', 'apply_patch', 'edit_file', 'get_tool_output', 'ask_user',
  'task_list', 'remember', 'recall_memory', 'recall_conversation', 'read_file', 'list_directory', 'exec_command', 'write_stdin']
  .map((name) => stub(name, name === 'ask_user' || name === 'task_list' ? { interactive: true } : {}));
const GROUPS = ['mcp__get_file_skeleton', 'mcp__get_symbol_body', 'mcp__prepare_edit', 'git_status', 'git_diff', 'rag_search_docs', 'rag_read_doc', 'invoke_skill']
  .map((name) => stub(name));
const OLD_TRIO = [top('spawn_agent'), top('resume_agent'), top('collect_agents')];
const OLD = new Set(OLD_TRIO.map((tool) => tool.name));
const CAPS = Array.from({ length: 25 }, (_, index) => 16 + index);
const RENAMED = '__counted_';
const names = (tools: readonly CoderTool[]) => tools.map((tool) => tool.name).sort();
const rest = (list: string[]) => list.filter((name) => !DELEGATION_FAMILY.has(name) && !OLD.has(name) && !name.startsWith(RENAMED));
const direct = (tools: readonly CoderTool[], cap: number) =>
  names(selectWorkflowCatalog(tools, { activeTiers: profileToTiers('full'), cap }).tools);
/** The same surface with the child-chat tools swapped for the old trio. */
const asOldTrio = (tools: readonly CoderTool[], cap: number) =>
  direct([...tools.filter((tool) => !DELEGATION_FAMILY.has(tool.name)), ...OLD_TRIO], cap);
/** The same surface with the child-chat tools renamed out of the family: counted as the tools present. */
const asPresent = (tools: readonly CoderTool[], cap: number) =>
  direct(tools.map((tool) => (DELEGATION_FAMILY.has(tool.name) ? { ...tool, name: `${RENAMED}${tool.name}` } : tool)), cap);

describe('delegation reserve', () => {
  it('is 3 slots for the child-chat tools', () => {
    expect(DELEGATION_RESERVE_SLOTS).toBe(3);
    expect([...DELEGATION_FAMILY].sort()).toEqual([...CHILD_CHAT_TOOL_NAMES].sort());
  });

  it('gives a root that can delegate the groups the old trio left room for, at every budget', () => {
    const on = [...CORE, ...GROUPS, top('create_chat'), top('send_chat_message')];
    let moved = 0;
    for (const cap of CAPS) {
      expect({ cap, groups: rest(direct(on, cap)) }).toEqual({ cap, groups: rest(asOldTrio(on, cap)) });
      if (JSON.stringify(rest(direct(on, cap))) !== JSON.stringify(rest(asPresent(on, cap)))) moved++;
    }
    expect(moved).toBeGreaterThan(0); // counting the 2 tools present would let the freed slot move groups
  });

  it('counts what a root that cannot delegate has', () => {
    const lone = [...CORE, ...GROUPS, top('send_chat_message')];
    for (const cap of CAPS) expect({ cap, groups: rest(direct(lone, cap)) }).toEqual({ cap, groups: rest(asPresent(lone, cap)) });
  });

  it.each(['explore', 'review', 'verify', 'implement', 'full'])('applies the same rule to a %s child at depth 1 and 4', async (profile) => {
    for (const depth of [1, 4]) {
      const child = (await loadChildAgentRun({ getChildAgentSession: async () => ({ id: 'c', parent_session_id: 'p', depth, profile, read_only: false } as never) },
        'c'))!;
      const authorized = scenarioRegistry({ agentId: 'build', child }).list();
      expect(authorized.some((tool) => tool.name === 'create_chat')).toBe(depth === 1);
      for (const cap of CAPS) {
        const expected = depth === 1 ? rest(asOldTrio(authorized, cap)) : rest(asPresent(authorized, cap));
        expect({ depth, cap, groups: rest(direct(authorized, cap)) }).toEqual({ depth, cap, groups: expected });
      }
    }
  });

  it('never applies in Company: it has no create_chat, so it counts the tools it has', () => {
    const company = scenarioRegistry({ agentId: 'build', company: true }).list();
    expect(company.some((tool) => tool.name === 'create_chat')).toBe(false);
    for (const cap of CAPS) expect({ cap, groups: rest(direct(company, cap)) }).toEqual({ cap, groups: rest(asPresent(company, cap)) });
  });
});
