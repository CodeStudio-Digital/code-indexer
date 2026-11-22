import { describe, expect, it } from 'vitest';
import { sideChatQuestion } from '../side-chat-command.js';

describe('side command routing', () => {
  it.each([['/side', ''], ['/btw', ''], [' /SIDE  qual é o modelo? ', 'qual é o modelo?'], ['/side linha 1\nlinha 2', 'linha 1\nlinha 2']])('opens %s', (input, question) => {
    expect(sideChatQuestion(input)).toBe(question);
  });
  it.each(['/sidebar', '/btw-extra', 'explica /side', 'texto normal'])('keeps %s in the main composer', input => {
    expect(sideChatQuestion(input)).toBeUndefined();
  });
});
