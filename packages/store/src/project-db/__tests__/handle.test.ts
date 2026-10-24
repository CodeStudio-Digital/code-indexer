import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ close: vi.fn(), initialize: vi.fn() }));
vi.mock('../open.js', () => ({ openRawProjectDb: () => ({ close: fixture.close }) }));
vi.mock('../project-schema.js', () => ({ initProjectSchema: fixture.initialize }));
import { ProjectDb } from '../handle.js';
beforeEach(() => { fixture.close.mockReset(); fixture.initialize.mockReset(); });

it('closes the physical connection when a migration prevents construction', () => {
  const failure = new Error('migration failed'); fixture.initialize.mockImplementation(() => { throw failure; });
  expect(() => new ProjectDb(1, ':memory:')).toThrow(failure);
  expect(fixture.close).toHaveBeenCalledOnce();
});

it('retains a successfully initialized connection until its owner closes it', () => {
  const project = new ProjectDb(1, ':memory:');
  expect(fixture.initialize).toHaveBeenCalledOnce(); expect(fixture.close).not.toHaveBeenCalled();
  project.close(); expect(fixture.close).toHaveBeenCalledOnce();
});
