import { expect, it } from 'vitest';
import { skillMention } from '../skill-mention.js';

it('opens skill completion at the caret anywhere in a message', () => {
  expect(skillMention('#', 1)).toEqual({ trigger: '#', query: '', start: 0, end: 1 });
  expect(skillMention('Revisar com #rea depois', 16)).toEqual({ trigger: '#', query: 'rea', start: 12, end: 16 });
  expect(skillMention('Texto\n#api', 10)?.query).toBe('api');
  expect(skillMention('/context7:docs', 14)?.trigger).toBe('/');
});
it('does not intercept code, headings, paths or already finished tokens', () => {
  for (const text of ['C#', '##', '# Título', 'https://host/#anchor', 'dir/file', '#skill ']) {
    expect(skillMention(text, text.length)).toBeNull();
  }
});
