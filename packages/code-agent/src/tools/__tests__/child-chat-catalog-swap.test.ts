/**
 * The swap, on the real tool builders (catalog-registry-fixture): with child
 * chats on, each scenario's direct catalog is the switch-off one without the
 * old delegation and chat tools, plus create_chat and send_chat_message where
 * they apply. No other tool enters or leaves (invoke_skill stays where it
 * was), at the default budget and at every budget from 16 to 40, where each
 * optional group crosses its limit; a freed slot stays empty. send_chat_message
 * is direct only where someone can answer; create_chat and stop_chat are not
 * registered where they would always be refused. Company sees none of it.
 */
import { describe, expect, it } from 'vitest';
import { chatToolsForRun, withTalkDeferred } from '../chat-tool-set.js';
import { REPLACED_BY_CHILD_CHATS } from '../child-chat-surface.js';
import { canInvokeInsideCodeExec } from '../code-exec-eligibility.js';
import { selectWorkflowCatalog } from '../workflow-catalog.js';
import { directCatalog, scenarioRegistry, type CatalogScenario } from './catalog-registry-fixture.js';

const names = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name);
const offChat = chatToolsForRun({ childChats: false, company: false });
const onChat = chatToolsForRun({ childChats: true, company: false });
/** The tools the swap may move: every chat or delegation tool that is not the very same tool in both surfaces. */
const FAMILY = new Set([...names(offChat), ...names(onChat), ...Object.keys(REPLACED_BY_CHILD_CHATS), 'spawn_agent', 'resume_agent', 'collect_agents']
  .filter((name) => !onChat.some((tool) => tool.name === name && offChat.includes(tool))));
const PAIR = ['create_chat', 'send_chat_message'];
const SCENARIOS: Array<[string, Omit<CatalogScenario, 'childChats'>, string[]]> = [
  ['Build with preview', { agentId: 'build', preview: true }, PAIR],
  ['Build', { agentId: 'build' }, PAIR],
  ['Plan', { agentId: 'plan' }, PAIR],
  ['Ultra', { agentId: 'build', ultra: true }, PAIR],
  ['Agêntico', { agentId: 'build', agenticChat: true }, PAIR],
  ['Explore', { agentId: 'explore' }, []],
  ['Explore in Agêntico', { agentId: 'explore', agenticChat: true }, ['send_chat_message']],
  ['sub-agents disabled', { agentId: 'build', subagentsDisabled: true }, []],
];
const CAPS = [undefined, ...Array.from({ length: 25 }, (_, index) => 16 + index)];

describe('child-chat catalog swap on the real builders', () => {
  it.each(SCENARIOS)('%s: only the delegation tools change, at every budget', (_label, scenario, pair) => {
    for (const cap of CAPS) {
      const off = directCatalog({ ...scenario, childChats: false }, cap).names;
      const on = directCatalog({ ...scenario, childChats: true }, cap).names;
      expect({ cap, rest: on.filter((name) => !FAMILY.has(name)) }).toEqual({ cap, rest: off.filter((name) => !FAMILY.has(name)) });
      expect({ cap, swapped: on.filter((name) => FAMILY.has(name)) }).toEqual({ cap, swapped: pair });
      expect(on).toEqual([...on].sort((a, b) => a.localeCompare(b)));
    }
  });

  it('keeps invoke_skill direct and the git group out where the switch-off budget had them so', () => {
    // The measured regression: the freed slot let git_status + git_diff in and pushed invoke_skill out.
    const caps = CAPS.filter((cap) => {
      const off = directCatalog({ agentId: 'build', childChats: false }, cap).names;
      return off.includes('invoke_skill') && !off.includes('git_status');
    });
    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) {
      const on = directCatalog({ agentId: 'build', childChats: true }, cap).names;
      expect({ cap, invokeSkill: on.includes('invoke_skill'), git: on.includes('git_status') }).toEqual({ cap, invokeSkill: true, git: false });
    }
  });

  it('leaves Company identical, whole', () => {
    for (const cap of CAPS) {
      expect(directCatalog({ agentId: 'build', company: true, childChats: true }, cap))
        .toEqual(directCatalog({ agentId: 'build', company: true, childChats: false }, cap));
    }
  });

  it('registers no create_chat or stop_chat where they would always be refused, and defers send_chat_message there', () => {
    for (const scenario of [{ agentId: 'explore' as const }, { agentId: 'build' as const, subagentsDisabled: true }]) {
      const registry = scenarioRegistry({ ...scenario, childChats: true });
      expect(registry.has('create_chat')).toBe(false);
      expect(registry.has('stop_chat')).toBe(false);
      expect(canInvokeInsideCodeExec(registry.get('send_chat_message')!)).toBe(true);
    }
    expect(canInvokeInsideCodeExec(scenarioRegistry({ agentId: 'build', childChats: true }).get('send_chat_message')!)).toBe(false);
    expect(withTalkDeferred(scenarioRegistry({ agentId: 'build', childChats: true }).get('read_chat')!).topLevelOnly)
      .toBe(scenarioRegistry({ agentId: 'build', childChats: true }).get('read_chat')!.topLevelOnly);
  });

  it('budgeting on the authorized surface itself changes nothing', () => {
    const authorized = scenarioRegistry({ agentId: 'build', childChats: false }).list();
    for (const cap of [20, 24, 28, 32]) {
      const plain = selectWorkflowCatalog(authorized, { activeTiers: null, cap });
      expect(names(selectWorkflowCatalog(authorized, { activeTiers: null, cap, budgetSurface: authorized }).tools)).toEqual(names(plain.tools));
    }
  });
});
