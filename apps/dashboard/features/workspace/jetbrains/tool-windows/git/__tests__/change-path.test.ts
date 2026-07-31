import { describe, expect, it } from 'vitest';
import { changePathParts } from '../change-path.js';

describe('Git change path presentation', () => {
  it('separates a nested path into its filename and parent directory', () => {
    expect(changePathParts('src/app/services/token.service.ts')).toEqual({
      name: 'token.service.ts',
      directory: 'src/app/services',
    });
  });

  it('marks repository-root files without repeating their filename', () => {
    expect(changePathParts('package.json')).toEqual({
      name: 'package.json',
      directory: '.',
    });
  });

  it('preserves spaces and dots in both display parts', () => {
    expect(changePathParts('docs/research notes/agent.memory.live.md')).toEqual({
      name: 'agent.memory.live.md',
      directory: 'docs/research notes',
    });
  });
});
