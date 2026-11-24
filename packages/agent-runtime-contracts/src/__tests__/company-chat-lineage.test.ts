import { expect, it } from 'vitest';
import { companyChatParents } from '../company-chat-lineage.js';

it('keeps old generations with their Master and honors an explicit Master across a replacement', () => {
  const chat = (id: string, role: string, minute: number, company = 'one', parent?: string) => ({
    id, created_at: new Date(60_000 * minute).toISOString(), parent_session_id: company,
    metadata: { company_session_id: company, company_role: role, company_master_chat_id: parent },
  });
  const chats = [
    chat('latest', 'master', 4), chat('original', 'master', 1), chat('other', 'master', 1, 'two'),
    chat('old-agent', 'review', 2), chat('new-agent', 'review', 5), chat('resumed-team', 'qa', 6, 'one', 'original'),
    chat('explicit-unavailable', 'dev', 6, 'one', 'missing'), chat('cross-company', 'qa', 7, 'one', 'other'),
    chat('predates-masters', 'dev', 0), chat('outside', 'review', 4, 'two'),
  ];
  expect([...companyChatParents(chats)]).toEqual([
    ['old-agent', 'original'], ['new-agent', 'latest'], ['resumed-team', 'original'], ['outside', 'other'],
  ]);
  expect(companyChatParents([...chats, chat('tie', 'master', 4)]).has('new-agent')).toBe(false);
});
