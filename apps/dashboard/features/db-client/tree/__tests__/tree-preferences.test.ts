import { describe, expect, it } from 'vitest';
import { preferredTreeName, restrictTreeNames } from '../tree-preferences.js';

describe('database tree preferences', () => {
  it('shows every discovered name when no filter is configured', () => {
    expect(restrictTreeNames(['app', 'audit'], '')).toEqual(['app', 'audit']);
    expect(restrictTreeNames(['app', 'audit'], undefined)).toEqual(['app', 'audit']);
  });

  it('shows only the configured database/schema and preserves server casing', () => {
    expect(restrictTreeNames(['master', 'DellSoftX', 'audit'], 'dellsoftx')).toEqual(['DellSoftX']);
  });

  it('keeps an unmatched preference visible instead of silently showing everything', () => {
    expect(restrictTreeNames(['dbo', 'guest'], 'custom')).toEqual(['custom']);
    expect(preferredTreeName('  dbo  ')).toBe('dbo');
  });
});
