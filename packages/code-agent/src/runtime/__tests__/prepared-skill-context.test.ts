import { expect, it } from 'vitest';
import { prepareSelectedSkillContext } from '../prepared-skill-context.js';

it('pins selected instructions without modifying user content or duplicating a skill', () => {
  const message = { role: 'user' as const, content: [{ type: 'text' as const, text: 'Review the code' }],
    selectedSkillIds: ['review', 'missing', 'review'] };
  let body = 'For ${PROJECT_NAME}: ${USER_INPUT}';
  const input = { messages: [message], template: { PROJECT_NAME: 'fixture', PROJECT_ROOT: '/repo', OS: 'win32', SESSION_ID: 's', TIMESTAMP: 'now' },
    getSkill: (id: string) => id === 'review' ? { id, name: 'Review', prompt_body: body } : undefined };
  const context = prepareSelectedSkillContext(input)!;
  body = 'changed later';
  expect(context.selectedSkillIds).toEqual(['review']);
  expect(context.contentUtf8).toContain('For fixture: Review the code');
  expect(message.content).toEqual([{ type: 'text', text: 'Review the code' }]);
  expect(prepareSelectedSkillContext(input)?.contentUtf8).toContain('changed later');
  expect(() => prepareSelectedSkillContext({ ...input, getSkill: id => id === 'review'
    ? { id, name: '', prompt_body: 'é'.repeat(128 * 1024) } : undefined })).toThrow('byte budget');
});
