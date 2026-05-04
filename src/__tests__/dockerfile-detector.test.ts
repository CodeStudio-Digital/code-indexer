import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectDockerfile } from '../core/sandbox/dockerfile-detector.js';

let tmpRoot: string | null = null;

function makeRoot(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mcp-dockerfile-'));
  return tmpRoot;
}

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
});

describe('detectDockerfile', () => {
  it('detects Dockerfile and parses EXPOSE ports', () => {
    const root = makeRoot();
    writeFileSync(
      join(root, 'Dockerfile'),
      ['FROM node:20', 'EXPOSE 3000 9229', 'CMD ["npm","run","dev"]'].join('\n'),
    );

    expect(detectDockerfile(root)).toEqual({
      path: join(root, 'Dockerfile'),
      exposedPorts: [3000, 9229],
    });
  });

  it('falls back to Containerfile', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'Containerfile'), 'FROM node:20\nEXPOSE 8080\n');

    expect(detectDockerfile(root)).toEqual({
      path: join(root, 'Containerfile'),
      exposedPorts: [8080],
    });
  });

  it('returns null when neither root-level file exists', () => {
    expect(detectDockerfile(makeRoot())).toBeNull();
  });

  it('returns an empty exposedPorts list when no EXPOSE is present', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'Dockerfile'), 'FROM node:20\n');

    expect(detectDockerfile(root)).toEqual({
      path: join(root, 'Dockerfile'),
      exposedPorts: [],
    });
  });
});
