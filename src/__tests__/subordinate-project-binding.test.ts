import { describe, it, expect } from 'vitest';
import { resolveSpawnProjectBinding } from '@mcp/company/services/SubordinateLifecycle.js';

describe('resolveSpawnProjectBinding', () => {
  describe('no binding (legacy free-form role)', () => {
    it('throws when project id is omitted', () => {
      expect(() =>
        resolveSpawnProjectBinding({
          role: 'adhoc',
          specProjectId: undefined,
          boundProjectIds: [],
        }),
      ).toThrow(/has no project binding/);
    });

    it('returns the supplied project id', () => {
      expect(
        resolveSpawnProjectBinding({
          role: 'adhoc',
          specProjectId: 42,
          boundProjectIds: [],
        }),
      ).toBe(42);
    });
  });

  describe('single-project binding', () => {
    it('auto-resolves to the bound project when project_id is omitted', () => {
      expect(
        resolveSpawnProjectBinding({
          role: 'frontend',
          specProjectId: undefined,
          boundProjectIds: [12],
        }),
      ).toBe(12);
    });

    it('accepts project_id when it matches the binding', () => {
      expect(
        resolveSpawnProjectBinding({
          role: 'frontend',
          specProjectId: 12,
          boundProjectIds: [12],
        }),
      ).toBe(12);
    });

    it('rejects project_id that does not match the binding', () => {
      expect(() =>
        resolveSpawnProjectBinding({
          role: 'frontend',
          specProjectId: 13,
          boundProjectIds: [12],
        }),
      ).toThrow(/bound to project 12.*project_id=13 is not allowed/);
    });
  });

  describe('multi-project binding', () => {
    it('uses the first bound project when project_id is omitted', () => {
      expect(
        resolveSpawnProjectBinding({
          role: 'qa',
          specProjectId: undefined,
          boundProjectIds: [12, 13],
        }),
      ).toBe(12);
    });

    it('accepts one of the bound project ids', () => {
      expect(
        resolveSpawnProjectBinding({
          role: 'qa',
          specProjectId: 13,
          boundProjectIds: [12, 13],
        }),
      ).toBe(13);
    });

    it('rejects project_id that is not in the binding list', () => {
      expect(() =>
        resolveSpawnProjectBinding({
          role: 'qa',
          specProjectId: 99,
          boundProjectIds: [12, 13],
        }),
      ).toThrow(/bound to projects \[12, 13\].*project_id=99 is not allowed/);
    });
  });
});
