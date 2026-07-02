import { describe, expect, it } from 'vitest';
import { DOCBLOCK_ON_ENTER, LANGUAGE_CONFIG_OVERLAYS } from '../language-configs/data.js';
// Base confs from the bundled basic-languages (same modules the Monaco
// contribution registers at runtime). c/cpp share the cpp module.
import { conf as phpConf } from 'monaco-editor/esm/vs/basic-languages/php/php.js';
import { conf as goConf } from 'monaco-editor/esm/vs/basic-languages/go/go.js';
import { conf as rustConf } from 'monaco-editor/esm/vs/basic-languages/rust/rust.js';
import { conf as javaConf } from 'monaco-editor/esm/vs/basic-languages/java/java.js';
import { conf as cppConf } from 'monaco-editor/esm/vs/basic-languages/cpp/cpp.js';
import { conf as csharpConf } from 'monaco-editor/esm/vs/basic-languages/csharp/csharp.js';
import { conf as kotlinConf } from 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.js';
import { conf as swiftConf } from 'monaco-editor/esm/vs/basic-languages/swift/swift.js';
import { conf as dartConf } from 'monaco-editor/esm/vs/basic-languages/dart/dart.js';

const BASE_CONFS: Record<string, object> = {
  php: phpConf, go: goConf, rust: rustConf, java: javaConf,
  c: cppConf, cpp: cppConf, csharp: csharpConf,
  kotlin: kotlinConf, swift: swiftConf, dart: dartConf,
};

describe('LANGUAGE_CONFIG_OVERLAYS', () => {
  it('has a base conf entry for every overlaid language', () => {
    expect(Object.keys(BASE_CONFS).sort()).toEqual(Object.keys(LANGUAGE_CONFIG_OVERLAYS).sort());
  });

  it('only defines properties the base conf is MISSING (per-property overlay contract)', () => {
    for (const [langId, overlay] of Object.entries(LANGUAGE_CONFIG_OVERLAYS)) {
      const baseKeys = new Set(Object.keys(BASE_CONFS[langId]));
      for (const key of Object.keys(overlay)) {
        expect(baseKeys.has(key), `${langId}.${key} already exists in the base conf`).toBe(false);
      }
    }
  });
});

describe('DOCBLOCK_ON_ENTER', () => {
  it('continues /** with " * " and mid-block lines with "* "', () => {
    const open = DOCBLOCK_ON_ENTER[1];
    expect(open.beforeText.test('    /** Sincroniza dados')).toBe(true);
    expect(open.beforeText.test('    /** closed */')).toBe(false);
    expect(open.action.appendText).toBe(' * ');
    const mid = DOCBLOCK_ON_ENTER[2];
    // JSDoc alignment: the `*` sits ONE space past the block's indent
    // (2-space groups + 1 space), e.g. `/**` at col 0 → ` * …`.
    expect(mid.beforeText.test(' * users_addresses')).toBe(true);
    expect(mid.beforeText.test('   * mid-block line')).toBe(true);
    expect(mid.beforeText.test('  $results = [];')).toBe(false);
    expect(mid.action.appendText).toBe('* ');
  });
});
