import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEMANTIC_TOKEN_TYPES, TsLanguageService } from '../ts-service.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ts-semantic-tokens-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface DecodedToken {
  line: number;
  column: number;
  length: number;
  type: (typeof SEMANTIC_TOKEN_TYPES)[number];
}

function decode(data: number[]): DecodedToken[] {
  const tokens: DecodedToken[] = [];
  let line = 0;
  let column = 0;
  for (let i = 0; i < data.length; i += 5) {
    const deltaLine = data[i];
    line += deltaLine;
    column = deltaLine === 0 ? column + data[i + 1] : data[i + 1];
    tokens.push({
      line,
      column,
      length: data[i + 2],
      type: SEMANTIC_TOKEN_TYPES[data[i + 3]],
    });
  }
  return tokens;
}

describe('TsLanguageService.getSemanticTokens', () => {
  it('decodes TypeScript classifier2020 types onto the zero-based Monaco legend', () => {
    const source = [
      'class User {',
      "  readonly name = '';",
      '  greet(person: User): string {',
      '    const local = person.name;',
      '    return local;',
      '  }',
      '}',
      'function make(user: User): string {',
      '  return user.greet(user);',
      '}',
      '',
    ].join('\n');
    writeFileSync(join(root, 'sample.ts'), source);

    const tokens = decode(new TsLanguageService(root).getSemanticTokens('sample.ts'));
    const at = (line: number, column: number) =>
      tokens.find((token) => token.line === line && token.column === column)?.type;

    expect(at(0, 6)).toBe('class'); // User declaration
    expect(at(1, 11)).toBe('property'); // name declaration
    expect(at(2, 2)).toBe('method'); // greet declaration (last legend type)
    expect(at(2, 8)).toBe('parameter'); // person
    expect(at(3, 10)).toBe('variable'); // local declaration
    expect(at(7, 9)).toBe('function'); // make declaration
    expect(at(8, 14)).toBe('method'); // greet reference
  });
});
