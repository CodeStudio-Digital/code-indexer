/** NGramIndex — learning, LRU bound, lex cap, scoring semantics. */
import { describe, it, expect } from 'vitest';
import { NGramIndex, MAX_FILES, LEX_CAP_CHARS } from '../ngram.js';

describe('NGramIndex', () => {
  it('scores bigram continuations above unigram familiarity above unseen', () => {
    const idx = new NGramIndex();
    idx.learnFile('a.ts', 'const client = createClient(); client.connect(); client.connect();', 1);
    const afterClient = idx.score('client', 'connect');
    const familiar = idx.score(null, 'createClient');
    const unseen = idx.score('client', 'destroy');
    expect(afterClient).toBeGreaterThan(familiar);
    expect(familiar).toBeGreaterThan(0);
    expect(unseen).toBeLessThan(afterClient);
    expect(idx.score('nothing', 'unknown')).toBe(0);
  });

  it('pools evidence across learned files', () => {
    const idx = new NGramIndex();
    idx.learnFile('a.ts', 'db.query(sql)', 1);
    idx.learnFile('b.ts', 'db.query(other)', 1);
    expect(idx.score('db', 'query')).toBeGreaterThan(0);
  });

  it('re-learn with the same version is a recency-only no-op; new version replaces', () => {
    const idx = new NGramIndex();
    idx.learnFile('a.ts', 'alpha beta', 1);
    idx.learnFile('a.ts', 'IGNORED TEXT', 1); // same version → keeps old counts
    expect(idx.score('alpha', 'beta')).toBeGreaterThan(0);
    idx.learnFile('a.ts', 'gamma delta', 2); // new version → relearn
    expect(idx.score('alpha', 'beta')).toBe(0);
    expect(idx.score('gamma', 'delta')).toBeGreaterThan(0);
    expect(idx.learnedVersion('a.ts')).toBe(2);
  });

  it(`bounds memory: evicts beyond ${MAX_FILES} files, forgets on demand`, () => {
    const idx = new NGramIndex();
    for (let i = 0; i <= MAX_FILES; i++) idx.learnFile(`f${i}.ts`, `token${i} follows${i}`, 1);
    expect(idx.learnedVersion('f0.ts')).toBeUndefined(); // eldest evicted
    expect(idx.learnedVersion(`f${MAX_FILES}.ts`)).toBe(1);
    idx.forgetFile(`f${MAX_FILES}.ts`);
    expect(idx.learnedVersion(`f${MAX_FILES}.ts`)).toBeUndefined();
  });

  it('caps lexing at LEX_CAP_CHARS', () => {
    const idx = new NGramIndex();
    const beyond = 'x'.repeat(LEX_CAP_CHARS) + ' tailToken tailFollows';
    idx.learnFile('big.ts', beyond, 1);
    expect(idx.score('tailToken', 'tailFollows')).toBe(0); // past the cap — never lexed
  });
});
