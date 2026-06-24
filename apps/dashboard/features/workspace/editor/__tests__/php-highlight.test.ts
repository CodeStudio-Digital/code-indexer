/**
 * Guards the enriched PHP Monarch grammar: (1) it must compile through Monaco's
 * own Monarch compiler (a group-count / structure error there throws at
 * setMonarchTokensProvider time and silently drops back to the plain tokenizer),
 * and (2) the differentiator regexes must classify the constructs the user cares
 * about — function call vs method vs property vs class.
 */
import { describe, it, expect } from 'vitest';
import { compile } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js';
import { enrichedPhp, PHP_EXTRA_RULES } from '../php-highlight.js';

// The function-call rule is the last EXTRA rule; its `cases` decide keyword vs
// construct vs function for an identifier before `(`.
const callRuleCases = (PHP_EXTRA_RULES[PHP_EXTRA_RULES.length - 1] as [RegExp, { cases: Record<string, string> }])[1].cases;

describe('enriched PHP grammar', () => {
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
