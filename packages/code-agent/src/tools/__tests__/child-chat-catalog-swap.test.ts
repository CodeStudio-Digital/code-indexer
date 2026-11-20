/**
 * The child-chat surface on the real tool builders (catalog-registry-fixture):
 * outside Company no old delegation tool is built and Agêntico has exactly
 * the normal session's catalog at every budget (the catalog has no Agêntico
 * option any more); send_chat_message is direct only where someone can
 * answer; create_chat and stop_chat are not registered where they would
 * always be refused. No session builds the old delegation tools, Company
 * included.
 */
import { describe, expect, it } from 'vitest';
import { withTalkDeferred } from '../chat-tool-set.js';
import { REPLACED_BY_CHILD_CHATS } from '../child-chat-surface.js';
import { canInvokeInsideCodeExec } from '../code-exec-eligibility.js';
import { directCatalog, scenarioRegistry } from './catalog-registry-fixture.js';

const names = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name);
const CAPS = [undefined, ...Array.from({ length: 25 }, (_, index) => 16 + index)];
const OLD_DELEGATION = ['spawn_agent', 'resume_agent', 'collect_agents', 'resume_chat', 'read_agent_transcript'];

describe('child-chat surface on the real builders', () => {
  it('gives Agêntico exactly the normal session catalog, with and without preview, at every budget', () => {
    for (const preview of [false, true]) {
      for (const cap of CAPS) {
        expect({ cap, preview, ...directCatalog({ agentId: 'build', agenticChat: true, preview }, cap) })
          .toEqual({ cap, preview, ...directCatalog({ agentId: 'build', preview }, cap) });
      }
    }
  });

  it('registers no create_chat or stop_chat where they would always be refused, and defers send_chat_message there', () => {
    for (const scenario of [{ agentId: 'explore' as const }, { agentId: 'build' as const, subagentsDisabled: true }]) {
      const registry = scenarioRegistry(scenario);
      expect(registry.has('create_chat')).toBe(false);
      expect(registry.has('stop_chat')).toBe(false);
      expect(canInvokeInsideCodeExec(registry.get('send_chat_message')!)).toBe(true);
    }
    expect(canInvokeInsideCodeExec(scenarioRegistry({ agentId: 'build' }).get('send_chat_message')!)).toBe(false);
    expect(withTalkDeferred(scenarioRegistry({ agentId: 'build' }).get('read_chat')!).topLevelOnly)
      .toBe(scenarioRegistry({ agentId: 'build' }).get('read_chat')!.topLevelOnly);
  });

  it('builds none of the old delegation tools, outside Company or in it', () => {
    const outside = names(scenarioRegistry({ agentId: 'build', ultra: true }).list());
    for (const name of Object.keys(REPLACED_BY_CHILD_CHATS)) expect(outside).not.toContain(name);
    for (const ultra of [false, true]) {
      const company = scenarioRegistry({ agentId: 'build', company: true, ultra });
      for (const name of OLD_DELEGATION) expect(company.has(name)).toBe(false);
      expect(company.has('create_chat')).toBe(false);
      expect(Object.keys(company.replacedTools()).sort()).toEqual([...OLD_DELEGATION].sort());
    }
  });
});
