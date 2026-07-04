import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import {
  isMetaTaskText,
  walkBackTaskText,
  latestUserTaskText,
  buildConversationTail,
  extractMessageText,
  planMemoryRecall,
} from '../memory-query.js';

const user = (text: string): AgentMessage => ({ role: 'user', content: text }) as unknown as AgentMessage;
const asst = (text: string): AgentMessage => ({ role: 'assistant', content: text }) as unknown as AgentMessage;

describe('isMetaTaskText', () => {
  it('flags PT-BR meta / continuation messages', () => {
    for (const t of [
      'Reanalise tudo que fez, se não deixou passar nada!',
      'continue',
      'continua',
      'prossiga',
      'faz de novo',
      'faça de novo',
      'novamente',
      'e agora?',
      'tem certeza?',
      'ok',
    ]) {
      expect(isMetaTaskText(t), t).toBe(true);
    }
  });

  it('flags EN meta / continuation messages', () => {
    for (const t of [
      'continue',
      'keep going',
      'go ahead',
      'check again',
      'are you sure?',
      'anything missing?',
      'redo it',
    ]) {
      expect(isMetaTaskText(t), t).toBe(true);
    }
  });

  it('does NOT flag messages with a substantive object', () => {
    for (const t of [
      'corrige o bug de auth no login.ts',
      'reanalise o retriever de memória em deps.ts',
      'add tests to the parser',
      'implement OAuth refresh flow',
      'fix login',
      'reanalise o memoryRetriever', // camelCase identifier survives
      'confere o `useAgentStream`', // backticked span
    ]) {
      expect(isMetaTaskText(t), t).toBe(false);
    }
  });

  it('treats empty as not-meta (caller handles empty separately)', () => {
    expect(isMetaTaskText('')).toBe(false);
    expect(isMetaTaskText('   ')).toBe(false);
  });
});

describe('walkBackTaskText', () => {
  it('skips trailing meta messages and returns the last substantive user text', () => {
    const msgs = [
      user('implement OAuth refresh flow'),
      asst('done, added refresh handler'),
      user('continue'),
      asst('kept going'),
      user('Reanalise tudo que fez!'),
    ];
    expect(walkBackTaskText(msgs)).toBe('implement OAuth refresh flow');
  });

  it('returns null when every user message is meta', () => {
    expect(walkBackTaskText([user('continue'), asst('ok'), user('faz de novo')])).toBeNull();
  });

  it('returns the latest substantive when the last message is already substantive', () => {
    const msgs = [user('old task'), user('add tests to login.ts')];
    expect(walkBackTaskText(msgs)).toBe('add tests to login.ts');
  });
});

describe('latestUserTaskText / extractMessageText', () => {
  it('extracts string content', () => {
    expect(latestUserTaskText([user('hello world'), asst('hi')])).toBe('hello world');
  });

  it('extracts and joins block-array content', () => {
    const msg = { role: 'user', content: [{ type: 'text', text: 'part a' }, { type: 'text', text: 'part b' }] };
    expect(extractMessageText(msg)).toBe('part a part b');
  });

  it('returns empty string for unknown content shapes', () => {
    expect(extractMessageText({ content: 42 })).toBe('');
    expect(extractMessageText({})).toBe('');
  });
});

describe('planMemoryRecall (query derivation + throttle)', () => {
  const history = [user('fix the null deref in deps.ts'), asst('fixed it'), user('continue')];

  it('turn 1 always retrieves; candidate is the walk-back for a meta message', () => {
    const plan = planMemoryRecall('continue', history, undefined, 1);
    expect(plan.meta).toBe(true);
    expect(plan.candidate).toBe('fix the null deref in deps.ts');
    expect(plan.shouldRetrieve).toBe(true);
  });

  it('a substantive message uses the raw text as the candidate/throttle key', () => {
    const plan = planMemoryRecall('add tests to login.ts', [user('add tests to login.ts')], undefined, 2);
    expect(plan.meta).toBe(false);
    expect(plan.candidate).toBe('add tests to login.ts');
    expect(plan.shouldRetrieve).toBe(true);
  });

  it('REGRESSION: a meta turn whose walk-back == last stable key does NOT re-fire', () => {
    // lastMemoryQuery holds the STABLE candidate from the prior retrieval — so a
    // continuation of the same task is throttled (no synth, no retrieve), even
    // though a synthesized query would have been a different string.
    const plan = planMemoryRecall('continue', history, 'fix the null deref in deps.ts', 5);
    expect(plan.shouldRetrieve).toBe(false);
  });

  it('fires again when the walk-back reaches a genuinely new task', () => {
    const plan = planMemoryRecall('continue', history, 'some older task', 5);
    expect(plan.candidate).toBe('fix the null deref in deps.ts');
    expect(plan.shouldRetrieve).toBe(true);
  });

  it('does not retrieve when there is no candidate (empty history + empty text)', () => {
    expect(planMemoryRecall('', [], undefined, 3).shouldRetrieve).toBe(false);
  });
});

describe('buildConversationTail', () => {
  it('returns the recent user/assistant turns in chronological order, truncated', () => {
    const msgs = [
      user('a'.repeat(600)),
      asst('b'),
      user('continue'),
    ];
    const tail = buildConversationTail(msgs, { maxCharsPerMessage: 100 });
    expect(tail).toEqual([
      { role: 'user', text: 'a'.repeat(100) },
      { role: 'assistant', text: 'b' },
      { role: 'user', text: 'continue' },
    ]);
  });

  it('caps the number of messages (keeping the most recent)', () => {
    const msgs = [user('m1'), user('m2'), user('m3'), user('m4')];
    const tail = buildConversationTail(msgs, { maxMessages: 2 });
    expect(tail.map((t) => t.text)).toEqual(['m3', 'm4']);
  });

  it('skips empty and non-user/assistant messages', () => {
    const msgs = [
      { role: 'system', content: 'sys' } as unknown as AgentMessage,
      user(''),
      { role: 'tool', content: 'tool out' } as unknown as AgentMessage,
      user('real task'),
    ];
    expect(buildConversationTail(msgs)).toEqual([{ role: 'user', text: 'real task' }]);
  });
});
