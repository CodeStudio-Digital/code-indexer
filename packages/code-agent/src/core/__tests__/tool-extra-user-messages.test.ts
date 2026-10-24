import { expect, it } from 'vitest';
import { isInternalToolReminder, toolExtraUserMessages } from '../tool-extra-user-messages.js';
const reminder = { type: 'text' as const, text: '<system-reminder>Mode transition</system-reminder>' };
const image = { type: 'image' as const, mediaType: 'image/png', base64: 'fixture' };

it('keeps mixed images and internal reminders in call order without hiding attachments', () => {
  const output = toolExtraUserMessages([
    { name: 'view_image', extraUserBlocks: [image] },
    { name: 'submit_spec', extraUserBlocks: [reminder] },
    { name: 'preview_screenshot', extraUserBlocks: [image] },
  ]);
  expect(output.map(message => !!message.isMeta)).toEqual([false, true, false]);
  expect(output[0]!.content[0]).toEqual(image); expect(output[2]!.content[0]).toEqual(image);
  expect(output[1]!.content).toEqual([reminder]);
});

it.each(['submit_spec', 'submit_plan', 'execute_tasks'])('marks only internal reminder content from %s', name => {
  expect(isInternalToolReminder(name, [reminder])).toBe(true);
  expect(isInternalToolReminder(name, [{ type: 'text', text: 'Ordinary text' }])).toBe(false);
  expect(isInternalToolReminder(name, [image, reminder])).toBe(false);
});

it('does not reinterpret content from external tools as internal harness instructions', () => {
  expect(isInternalToolReminder('ext_server__tool', [reminder])).toBe(false);
  expect(isInternalToolReminder(undefined, [reminder])).toBe(false);
  const output = toolExtraUserMessages([{ name: 'external', extraUserBlocks: [reminder] }]);
  expect(output[0]!.isMeta).toBeUndefined(); expect(output[0]!.content).toEqual([reminder]);
});
