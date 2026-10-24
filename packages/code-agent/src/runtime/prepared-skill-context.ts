import { create } from '@bufbuild/protobuf';
import { agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import type { AgentMessage } from '../core/messages.js';
import { interpolateSkillVars } from '../skills/prompt-injector.js';
import type { SkillTemplateContext } from '../skills/types.js';

/** Resolve once at command admission. Subsequent provider turns and recovery
 * use these exact bytes rather than re-reading a mutable skill definition. */
export function prepareSelectedSkillContext(input: {
  messages: readonly AgentMessage[];
  template: SkillTemplateContext;
  getSkill(id: string): { id: string; name: string; prompt_body: string } | null | undefined;
}): wire.ProviderPreparedUserContextV1 | undefined {
  const last = input.messages.at(-1);
  if (last?.role !== 'user' || !last.selectedSkillIds?.length) return undefined;
  if (last.selectedSkillIds.length > 32) throw new Error('Too many selected skills');
  const userInput = last.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const selectedSkillIds: string[] = [];
  const blocks: string[] = [];
  for (const id of new Set(last.selectedSkillIds)) {
    const skill = input.getSkill(id);
    if (!skill) continue;
    if (skill.id !== id || !id || Buffer.byteLength(id) > 128 || /[\u0000-\u001f]/.test(id)) {
      throw new Error('Invalid selected skill identity');
    }
    selectedSkillIds.push(id);
    blocks.push(`## ${id} — ${skill.name}\n\n${interpolateSkillVars(skill.prompt_body, { ...input.template, USER_INPUT: userInput })}`);
  }
  if (!blocks.length) return undefined;
  const contentUtf8 = `<active_skills>\n${blocks.join('\n\n')}\n</active_skills>`;
  if (Buffer.byteLength(contentUtf8) > 128 * 1024) throw new Error('Selected skill instructions exceed their byte budget');
  return create(wire.ProviderPreparedUserContextV1Schema, { messageIndex: input.messages.length - 1, selectedSkillIds, contentUtf8 });
}
