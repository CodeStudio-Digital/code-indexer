import { describe, it, expect } from 'vitest';
import {
  parseLanguageLevels,
  readLanguageLevel,
  effectiveLanguageLevel,
  writeLanguageLevel,
  isLangLevelKey,
  levelsFor,
  defaultLevelFor,
  floorFromConstraint,
  snapToLevels,
  phpLevelFromComposer,
  pythonLevelFromPyproject,
  PHP_LEVELS,
  PYTHON_LEVELS,
  DEFAULT_PHP_LEVEL,
  DEFAULT_PYTHON_LEVEL,
} from '../language-levels.js';

describe('language-levels', () => {
  it('parse tolerante: NULL/inválido/shape errado → {}', () => {
    expect(parseLanguageLevels(null)).toEqual({});
    expect(parseLanguageLevels(undefined)).toEqual({});
    expect(parseLanguageLevels('')).toEqual({});
    expect(parseLanguageLevels('{nope')).toEqual({});
    expect(parseLanguageLevels('123')).toEqual({});
    expect(parseLanguageLevels('null')).toEqual({});
    expect(parseLanguageLevels('{"php":42}')).toEqual({}); // valor não-string é ignorado
    expect(parseLanguageLevels('{"php":""}')).toEqual({}); // string vazia ignorada
  });

  it('parse mantém só chaves conhecidas com string não-vazia', () => {
    expect(parseLanguageLevels('{"php":"8.2","python":"3.11","go":"1.22"}')).toEqual({
      php: '8.2',
      python: '3.11',
    });
  });

  it('readLanguageLevel devolve a escolhida ou undefined', () => {
    expect(readLanguageLevel('{"php":"7.1"}', 'php')).toBe('7.1');
    expect(readLanguageLevel('{"php":"7.1"}', 'python')).toBeUndefined();
    expect(readLanguageLevel(null, 'php')).toBeUndefined();
  });

  it('effectiveLanguageLevel cai no default quando não setado', () => {
    expect(effectiveLanguageLevel(null, 'php')).toBe(DEFAULT_PHP_LEVEL);
    expect(effectiveLanguageLevel('{"php":"7.4"}', 'php')).toBe('7.4');
    expect(effectiveLanguageLevel('{"php":"7.4"}', 'python')).toBe(DEFAULT_PYTHON_LEVEL);
  });

  it('writeLanguageLevel funde sem apagar a outra chave', () => {
    const a = writeLanguageLevel(null, 'php', '8.2');
    expect(parseLanguageLevels(a)).toEqual({ php: '8.2' });
    const b = writeLanguageLevel(a, 'python', '3.10');
    expect(parseLanguageLevels(b)).toEqual({ php: '8.2', python: '3.10' });
    const c = writeLanguageLevel(b, 'php', '7.4'); // sobrescreve só php
    expect(parseLanguageLevels(c)).toEqual({ php: '7.4', python: '3.10' });
  });

  it('writeLanguageLevel sobre JSON corrompido começa limpo', () => {
    expect(parseLanguageLevels(writeLanguageLevel('{bad', 'php', '8.0'))).toEqual({ php: '8.0' });
  });

  it('isLangLevelKey só aceita php/python', () => {
    expect(isLangLevelKey('php')).toBe(true);
    expect(isLangLevelKey('python')).toBe(true);
    expect(isLangLevelKey('typescript')).toBe(false);
    expect(isLangLevelKey('java')).toBe(false);
  });

  it('levelsFor/defaultLevelFor coerentes', () => {
    expect(levelsFor('php')).toContain('8.4');
    expect(levelsFor('php')).toContain('5.6');
    expect(levelsFor('python')).toContain('3.13');
    expect(defaultLevelFor('php')).toBe(DEFAULT_PHP_LEVEL);
    expect(defaultLevelFor('python')).toBe(DEFAULT_PYTHON_LEVEL);
    // o default precisa existir na lista ofertada
    expect(levelsFor('php')).toContain(defaultLevelFor('php'));
    expect(levelsFor('python')).toContain(defaultLevelFor('python'));
  });

  describe('floorFromConstraint', () => {
    it.each([
      ['>=8.1', '8.1'],
      ['^8.1', '8.1'],
      ['~8.1.0', '8.1'],
      ['8.1.*', '8.1'],
      ['>=7.4 <8.0', '7.4'], // primeiro número = piso
      ['8.*', '8.0'], // só major → minor 0
      ['8', '8.0'],
      ['>=3.10,<4.0', '3.10'],
      ['== 3.9', '3.9'],
    ])('%s → %s', (input, expected) => {
      expect(floorFromConstraint(input)).toBe(expected);
    });
    it('sem número → undefined', () => {
      expect(floorFromConstraint('*')).toBeUndefined();
      expect(floorFromConstraint('')).toBeUndefined();
    });
  });

  describe('snapToLevels', () => {
    it('match exato', () => {
      expect(snapToLevels('8.1', PHP_LEVELS)).toBe('8.1');
      expect(snapToLevels('3.10', PYTHON_LEVELS)).toBe('3.10');
    });
    it('acima do teto → maior nível ≤ alvo', () => {
      expect(snapToLevels('8.9', PHP_LEVELS)).toBe('8.4');
    });
    it('abaixo de todos → menor da lista', () => {
      expect(snapToLevels('5.0', PHP_LEVELS)).toBe('5.6');
      expect(snapToLevels('3.5', PYTHON_LEVELS)).toBe('3.7');
    });
    it('entre níveis → maior ≤ alvo (PHP não tem 8.x sem .0; usa o piso)', () => {
      expect(snapToLevels('3.11', PYTHON_LEVELS)).toBe('3.11');
    });
  });

  describe('phpLevelFromComposer', () => {
    it('require.php', () => {
      expect(phpLevelFromComposer('{"require":{"php":"^8.1"}}')).toBe('8.1');
      expect(phpLevelFromComposer('{"require":{"php":">=7.4"}}')).toBe('7.4');
    });
    it('config.platform.php tem prioridade', () => {
      expect(
        phpLevelFromComposer('{"require":{"php":"^8.1"},"config":{"platform":{"php":"7.4.33"}}}'),
      ).toBe('7.4');
    });
    it('sem require.php / JSON inválido → undefined', () => {
      expect(phpLevelFromComposer('{"require":{"monolog/monolog":"^3"}}')).toBeUndefined();
      expect(phpLevelFromComposer('{nope')).toBeUndefined();
    });
  });

  describe('pythonLevelFromPyproject', () => {
    it('[project] requires-python', () => {
      expect(pythonLevelFromPyproject('[project]\nrequires-python = ">=3.10"\n')).toBe('3.10');
    });
    it('[tool.poetry.dependencies] python', () => {
      expect(
        pythonLevelFromPyproject('[tool.poetry.dependencies]\npython = "^3.9"\nrequests = "*"\n'),
      ).toBe('3.9');
    });
    it('sem versão → undefined', () => {
      expect(pythonLevelFromPyproject('[project]\nname = "x"\n')).toBeUndefined();
    });
  });
});
