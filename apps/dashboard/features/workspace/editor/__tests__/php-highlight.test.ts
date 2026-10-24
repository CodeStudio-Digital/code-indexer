/**
 * Guards the enriched PHP Monarch grammar: (1) it must compile through Monaco's
 * own Monarch compiler (a group-count / structure error there throws at
 * setMonarchTokensProvider time and silently drops back to the plain tokenizer),
 * and (2) the differentiator regexes must classify the constructs the user cares
 * about — function call vs method vs property vs class.
 */
import { describe, it, expect, vi } from 'vitest';
import { compile } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js';
import { enrichPhpHighlighting, enrichedPhp, PHP_EXTRA_RULES } from '../php-highlight.js';
import { tokenizeLine, tokenFor } from './monarch-tokenize.js';

/** PHP's own entry state is the HTML host; code lives in `phpRoot`. */
const php = (line: string) => tokenizeLine(enrichedPhp(), line, { languageId: 'php', start: 'phpRoot' });

// The function-call rule is the last EXTRA rule; its `cases` decide keyword vs
// construct vs function for an identifier before `(`.
const callRuleCases = (PHP_EXTRA_RULES[PHP_EXTRA_RULES.length - 1] as [RegExp, { cases: Record<string, string> }])[1].cases;

describe('enriched PHP grammar', () => {
  it('replaces the lazy tokenizer factory exactly once per Monaco instance', () => {
    const registerTokensProviderFactory = vi.fn((_language: string, _factory: { create(): unknown }) => ({ dispose() {} }));
    const monaco = { languages: { registerTokensProviderFactory } } as never;

    enrichPhpHighlighting(monaco);
    enrichPhpHighlighting(monaco);

    expect(registerTokensProviderFactory).toHaveBeenCalledTimes(1);
    expect(registerTokensProviderFactory).toHaveBeenCalledWith(
      'php',
      expect.objectContaining({ create: expect.any(Function) }),
    );
    const factory = registerTokensProviderFactory.mock.calls[0][1] as { create(): unknown };
    expect(factory.create()).toMatchObject({ tokenizer: expect.any(Object) });
  });

  it('compiles through Monaco without structural errors', () => {
    const lexer = compile('php', enrichedPhp() as never) as { tokenizer: Record<string, unknown>; start: string };
    expect(Object.keys(lexer.tokenizer).length).toBeGreaterThan(0);
    expect(lexer.start).toBe('root');
  });

  // The first rule that matches a given fragment decides its colour. We replay
  // the prepend order against representative fragments and assert which scope
  // the winning rule assigns (or that the rule's regex captures the symbol).
  const ruleAt = (src: string) => {
    for (const [re, action] of PHP_EXTRA_RULES as Array<[RegExp, unknown]>) {
      const m = new RegExp(re.source).exec(src);
      if (m && m.index === 0) return { m, action };
    }
    return null;
  };

  it('colours a method call (->name() ) as a member function', () => {
    const r = ruleAt('->firstWhere(');
    expect(r?.action).toEqual(['delimiter.php', 'white', 'entity.name.function.member']);
    expect(r?.m[3]).toBe('firstWhere');
  });

  it('colours property access (->name) as a property', () => {
    const r = ruleAt('->repository');
    expect(r?.action).toEqual(['delimiter.php', 'white', 'variable.other.property']);
    expect(r?.m[3]).toBe('repository');
  });

  it('colours a static method (::name() ) as a member function', () => {
    const r = ruleAt('::get($email)');
    expect(r?.action).toEqual(['delimiter.php', 'white', 'entity.name.function.member']);
  });

  it('colours an all-caps class constant (::CONST) as a constant', () => {
    const r = ruleAt('::MAX_RETRIES');
    expect(r?.action).toEqual(['delimiter.php', 'white', 'variable.other.constant']);
  });

  it('colours a class name before :: as a type (Cache::)', () => {
    const r = ruleAt('Cache::get');
    expect(r?.action).toHaveProperty('cases');
    expect(r?.m[0]).toBe('Cache');
  });

  it('colours a function/class declaration name', () => {
    expect(ruleAt('function findUser')?.action).toEqual(['keyword.php', 'white', 'entity.name.function']);
    expect(ruleAt('class UserService')?.action).toEqual(['keyword.php', 'white', 'entity.name.type']);
    expect(ruleAt('extends Model')?.action).toEqual(['keyword.php', 'white', 'entity.name.type']);
  });

  it('colours a bare function call as a function', () => {
    const r = ruleAt('strlen(');
    expect(r?.action).toHaveProperty('cases');
  });

  it('routes language constructs to the function colour, before the keyword case', () => {
    // @phpConstructs must be evaluated BEFORE @phpKeywords so isset()/empty()
    // colour as functions rather than keywords.
    const keys = Object.keys(callRuleCases);
    expect(keys.indexOf('@phpConstructs')).toBeLessThan(keys.indexOf('@phpKeywords'));
    expect(callRuleCases['@phpConstructs']).toBe('entity.name.function');
  });

  // PHP 8 attributes open with `#`, which the bundled grammar reads as a line
  // comment — the whole declaration greyed out. They are annotations, not
  // comments, so they must carry the `annotation` scope every theme paints.
  describe('PHP 8 attributes', () => {
    it('scopes the attribute and its name as an annotation, never a comment', () => {
      const tokens = php("#[Route(path: '/users', code: StatusCode::OK)]");
      expect(tokens.filter((t) => t.token.startsWith('comment'))).toEqual([]);
      expect(tokenFor(tokens, '#[')).toMatch(/^annotation/);
      expect(tokenFor(tokens, 'Route')).toMatch(/^annotation/);
      expect(tokenFor(tokens, ']')).toMatch(/^annotation/);
    });

    it('keeps ordinary PHP colours inside the argument list', () => {
      const tokens = php("#[Route(path: '/users', code: StatusCode::OK)]");
      expect(tokenFor(tokens, '/users')).toMatch(/^string/);
      expect(tokenFor(tokens, 'StatusCode')).toMatch(/^entity\.name\.type/);
      expect(tokenFor(tokens, 'OK')).toMatch(/^variable\.other\.constant/);
    });

    it('handles grouped and namespaced attributes', () => {
      const tokens = php('#[Deprecated, App\\Attr\\Authenticated]');
      expect(tokenFor(tokens, 'Deprecated')).toMatch(/^annotation/);
      expect(tokenFor(tokens, 'App\\Attr\\Authenticated')).toMatch(/^annotation/);
    });

    it('closes on the matching bracket, so following code is normal again', () => {
      const tokens = php('#[Attr([1, 2])] class UserService {}');
      expect(tokenFor(tokens, 'class')).toMatch(/^keyword/);
      expect(tokenFor(tokens, 'UserService')).toMatch(/^entity\.name\.type/);
    });

    it('still treats a real `#` line comment as a comment', () => {
      const tokens = php('# plain note about the code');
      expect(tokens.every((t) => t.token.startsWith('comment'))).toBe(true);
    });
  });

  it('classifies isset/empty as constructs but if/while as keywords', () => {
    const constructs = (enrichedPhp() as unknown as { phpConstructs: string[] }).phpConstructs;
    expect(constructs).toContain('isset');
    expect(constructs).toContain('empty');
    expect(constructs).toContain('unset');
    expect(constructs).not.toContain('if');
    expect(constructs).not.toContain('while');
    expect(constructs).not.toContain('for');
  });
});
