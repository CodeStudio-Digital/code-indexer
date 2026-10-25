import { expect, it } from 'vitest';
import { sessionMention } from '../useSessionReferences.js';
it('offers chats and projects at token boundaries without treating email as a mention', () => {
  expect(sessionMention('Debata com @Rev', 15)).toMatchObject({ trigger: '@', query: 'Rev' });
  expect(sessionMention('Use $Backend', 12)).toMatchObject({ trigger: '$', query: 'Backend' });
  expect(sessionMention('dev@example.com', 15)).toBeNull();
  expect(sessionMention('texto @', 7)).toMatchObject({ trigger: '@', query: '' });
});
