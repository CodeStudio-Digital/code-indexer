import { describe, expect, it } from 'vitest';
import { parseAppWorkspace } from '../builder-config.js';

describe('parseAppWorkspace', () => {
  it('parses a kind:app workspace with defaults', () => {
    expect(parseAppWorkspace(JSON.stringify({
      stack: 'cf-fullstack',
      port: 5183,
      kind: 'app',
      appName: 'Lanchonete',
      appSlug: 'lanchonete',
      dbEngine: 'd1',
    }))).toEqual({
      stack: 'cf-fullstack',
      port: 5183,
      appName: 'Lanchonete',
      appSlug: 'lanchonete',
      dbEngine: 'd1',
    });
  });

  it('returns null for other kinds and missing data', () => {
    expect(parseAppWorkspace(JSON.stringify({ kind: 'builder' }))).toBeNull();
    expect(parseAppWorkspace(null)).toBeNull();
  });
});
