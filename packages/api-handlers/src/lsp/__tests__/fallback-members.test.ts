import { describe, expect, it } from 'vitest';
import {
  buildSymbolCompletion,
  describeLocation,
  detectMemberTrigger,
  enclosingClass,
  isTypePosition,
} from '../fallback-members.js';
import type { DBSymbol } from '@mcp/shared/types.js';

function sym(over: Partial<DBSymbol>): DBSymbol {
  return {
    id: 1, project_id: 7, file_id: 1, file_path: 'a.php', name: 'x', kind: 'method',
    signature: null, parent: null, modifiers: null, return_type: null, parameters: null,
    line: 1, col: 1, end_line: null, exported: 1, comment: null, tags: null,
    stable_id: 's', created_at: '',
    ...over,
  } as DBSymbol;
}

describe('detectMemberTrigger', () => {
  it('detects $this-> instance access with the typed prefix', () => {
    const line = '        $this->exec';
    const t = detectMemberTrigger(line, line.length + 1);
    expect(t).toEqual({ access: 'instance', receiver: '$this', prefix: 'exec' });
  });

  it('detects Cls:: static access', () => {
    const line = 'return SwaggerResource::cl';
    const t = detectMemberTrigger(line, line.length + 1);
    expect(t).toEqual({ access: 'static', receiver: 'SwaggerResource', prefix: 'cl' });
  });

  it('detects self:: and an empty prefix right after the operator', () => {
    const line = '   self::';
    const t = detectMemberTrigger(line, line.length + 1);
    expect(t).toEqual({ access: 'static', receiver: 'self', prefix: '' });
  });

  it('keeps FQN backslashes in the static receiver token', () => {
    const line = 'App\\Models\\User::find';
    const t = detectMemberTrigger(line, line.length + 1);
    expect(t.access).toBe('static');
    expect(t.receiver).toBe('App\\Models\\User');
    expect(t.prefix).toBe('find');
  });

  it('returns access=null for a plain word (no member operator)', () => {
    const line = '    new Profi';
    expect(detectMemberTrigger(line, line.length + 1).access).toBeNull();
  });
});

describe('enclosingClass', () => {
  const syms = [
    sym({ name: 'PotatoCore', kind: 'class', line: 10, end_line: 80 }),
    sym({ name: 'helper', kind: 'function', line: 5, end_line: 8 }),
  ];
  it('returns the class whose [line,end_line] brackets the cursor', () => {
    expect(enclosingClass(syms, 42)).toBe('PotatoCore');
  });
  it('returns null outside any class body', () => {
    expect(enclosingClass(syms, 3)).toBeNull();
  });
  it('falls back to nearest class above when end_line is null', () => {
    expect(enclosingClass([sym({ name: 'C', kind: 'class', line: 10, end_line: null })], 999)).toBe('C');
  });
});

describe('buildSymbolCompletion', () => {
  it('inserts a method with params as a snippet, cursor between parens', () => {
    const item = buildSymbolCompletion(sym({ name: 'foo', kind: 'method', parameters: '($a, $b)' }), 0);
    expect(item.insertText).toBe('foo($1)');
    expect(item.insertTextFormat).toBe(2);
  });

  it('inserts a no-arg method as name()$0', () => {
    const item = buildSymbolCompletion(sym({ name: 'boot', kind: 'method', parameters: '()' }), 1);
    expect(item.insertText).toBe('boot()$0');
    expect(item.insertTextFormat).toBe(2);
  });

  it('keeps non-callables plaintext (no snippet $ hazard)', () => {
    const item = buildSymbolCompletion(sym({ name: 'instance', kind: 'property' }), 0);
    expect(item.insertText).toBe('instance');
    expect(item.insertTextFormat).toBe(1);
  });

  it('zero-pads the proximity tier into sortText and shows the namespace/dir on demand', () => {
    const item = buildSymbolCompletion(
      sym({ name: 'User', kind: 'class', file_path: 'app/Models/User.php' }), 3, { showPath: true },
    );
    expect(item.sortText).toBe('03User');
    expect(item.labelDetails).toEqual({ description: 'app/Models' }); // dir, not full path
  });

  it('renders PHP locations with backslashes (IntelliJ namespace look)', () => {
    const item = buildSymbolCompletion(
      sym({ name: 'ProfileService', kind: 'class', file_path: 'domain/service/users/ProfileService.php' }),
      2, { showPath: true, languageId: 'php' },
    );
    expect(item.labelDetails).toEqual({ description: 'domain\\service\\users' });
  });
});

describe('isTypePosition', () => {
  it('true after new / extends / implements / instanceof / use', () => {
    expect(isTypePosition('        new ')).toBe(true);
    expect(isTypePosition('class A extends ')).toBe(true);
    expect(isTypePosition('class A implements ')).toBe(true);
    expect(isTypePosition('if ($x instanceof ')).toBe(true);
    expect(isTypePosition('use ')).toBe(true);
  });
  it('false in a plain expression position', () => {
    expect(isTypePosition('        $x = ')).toBe(false);
    expect(isTypePosition('return ')).toBe(false);
    expect(isTypePosition('  newcomer')).toBe(false); // not the `new ` keyword
  });
});

describe('describeLocation', () => {
  it('returns the dir, PHP with backslashes', () => {
    expect(describeLocation('a/b/c/File.php', 'php')).toBe('a\\b\\c');
    expect(describeLocation('a/b/c/File.ts', 'typescript')).toBe('a/b/c');
    expect(describeLocation('Top.php', 'php')).toBe('');
  });
});
