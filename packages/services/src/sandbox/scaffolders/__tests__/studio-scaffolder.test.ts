/**
 * Locks the registry contract for Builder studio mode: `studio: true`
 * swaps in the instrumented `BuilderScaffolder` for stacks that have a
 * source-stamp plugin (react-ts today), and falls through to the plain
 * scaffolder otherwise. The stack identity is preserved either way.
 */
import { describe, it, expect } from 'vitest';
import { getScaffolder } from '../registry.js';
import { BuilderScaffolder } from '../builder-scaffolder.js';
import { ReactTsScaffolder } from '../react-ts-scaffolder.js';
import { VueTsScaffolder } from '../vue-ts-scaffolder.js';

describe('getScaffolder — studio routing', () => {
  it('returns BuilderScaffolder for react-ts when studio is on', () => {
    const s = getScaffolder('react-ts', { studio: true });
    expect(s).toBeInstanceOf(BuilderScaffolder);
    expect(s.stack).toBe('react-ts');
  });

  it('returns the plain scaffolder for react-ts without studio', () => {
    expect(getScaffolder('react-ts')).toBeInstanceOf(ReactTsScaffolder);
  });

  it('falls through to the plain scaffolder for stacks without a stamp plugin', () => {
    // Vue has no source-stamp plugin yet → studio falls back to plain.
    expect(getScaffolder('vue-ts', { studio: true })).toBeInstanceOf(VueTsScaffolder);
  });
});
