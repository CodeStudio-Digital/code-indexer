import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { buildConceptFtsMatch } from '../lexical-concepts.js';
import { buildFtsMatch, columnFtsMatch } from '@mcp/store/db/fts-query.js';

describe('conceptual programming vocabulary', () => {
  it('keeps exact identifiers and paths byte-identical to the canonical builder', () => {
    for (const query of ['sessão', 'auth.session', 'src/arquivo.ts', 'read_file', 'findTools']) {
      expect(buildConceptFtsMatch(query, 'AND')).toBe(buildFtsMatch(query, 'AND'));
    }
  });
  it('finds English source comments from Portuguese concepts on the compact content index', () => {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE VIRTUAL TABLE docs USING fts5(body, detail=column); INSERT INTO docs VALUES ('Password authentication configuration'), ('A numeric fixture record');");
      const match = columnFtsMatch(buildConceptFtsMatch('Onde está a configuração da senha?', 'OR'));
      expect(db.prepare('SELECT rowid FROM docs WHERE docs MATCH ?').all(match)).toEqual([{ rowid: 1 }]);
      for (const query of ['Como "arquivo" OR NOT tabela:senha*?', 'Onde (arquivo) / pasta?', 'Como "\"\"" funciona?']) {
        expect(() => db.prepare('SELECT rowid FROM docs WHERE docs MATCH ?').all(columnFtsMatch(buildConceptFtsMatch(query, 'OR')))).not.toThrow();
      }
    } finally { db.close(); }
  });
  it('bounds expansion and preserves English prose after stopword removal', () => {
    expect(buildConceptFtsMatch('Where is the timeout?', 'OR')).toBe('"timeout?"');
    expect(buildConceptFtsMatch('Onde ' + 'arquivo '.repeat(1000), 'AND').length).toBeLessThan(2500);
  });
});
