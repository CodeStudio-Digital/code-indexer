import { describe, expect, it } from 'vitest';
import {
  resolveSpawnProjectBinding,
  resolveSpawnProjectScope,
} from '../spec.js';

describe('resolveSpawnProjectBinding', () => {
  it('requires an explicit project for an unbound role', () => {
    expect(() =>
      resolveSpawnProjectBinding({
        role: 'reviewer',
        specProjectId: undefined,
        boundProjectIds: [],
      }),
    ).toThrow(/no project binding/i);
  });

  it('auto-selects the only bound project', () => {
    expect(
      resolveSpawnProjectBinding({
        role: 'backend',
        specProjectId: undefined,
        boundProjectIds: [184],
      }),
    ).toBe(184);
  });

  it('auto-selects the first project for a multi-project role', () => {
    expect(
      resolveSpawnProjectBinding({
        role: 'architect',
        specProjectId: undefined,
        boundProjectIds: [184, 185, 186],
      }),
    ).toBe(184);
  });

  it('accepts another bound project as the primary root', () => {
    expect(
      resolveSpawnProjectBinding({
        role: 'qa',
        specProjectId: 186,
        boundProjectIds: [184, 185, 186],
      }),
    ).toBe(186);
  });

  it('keeps every bound project while moving the selected primary first', () => {
    expect(
      resolveSpawnProjectScope({
        role: 'qa',
        specProjectId: 186,
        boundProjectIds: [184, 185, 186, 185],
      }),
    ).toEqual({
      projectId: 186,
      projectIds: [186, 184, 185],
    });
  });

  it('rejects a project outside the role binding', () => {
    expect(() =>
      resolveSpawnProjectBinding({
        role: 'frontend',
        specProjectId: 184,
        boundProjectIds: [185],
      }),
    ).toThrow(/not allowed/i);
  });
});
