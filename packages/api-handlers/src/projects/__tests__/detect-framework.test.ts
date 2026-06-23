/**
 * Framework classification from package.json deps (drives the preview
 * element-selector mode). Writes throwaway package.json files in an OS temp
 * dir — pure node:fs, no DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectProjectFramework } from '../detect-framework.js';

let root: string;

function project(pkg: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(root, 'proj-'));
  if (pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg), 'utf8');
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'detect-fw-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('detectProjectFramework', () => {
  it('detects next (precedence over react)', () => {
    const dir = project({ dependencies: { next: '15.0.0', react: '19.0.0', 'react-dom': '19.0.0' } });
    expect(detectProjectFramework(dir)).toBe('next');
  });

  it('detects react from dependencies', () => {
    const dir = project({ dependencies: { react: '18.2.0', 'react-dom': '18.2.0' } });
    expect(detectProjectFramework(dir)).toBe('react');
  });

  it('detects react from react-dom alone (devDependencies)', () => {
    const dir = project({ devDependencies: { 'react-dom': '18.2.0' } });
    expect(detectProjectFramework(dir)).toBe('react');
  });

  // Lock the lower precedence tiers so a future reorder of the if-chain can't
  // silently misclassify mixed/migration repos.
  it('react wins over vue when both are present', () => {
    const dir = project({ dependencies: { react: '18.2.0', vue: '3.4.0' } });
    expect(detectProjectFramework(dir)).toBe('react');
  });

  it('vue wins over angular when both are present', () => {
    const dir = project({ dependencies: { vue: '3.4.0', '@angular/core': '17.0.0' } });
    expect(detectProjectFramework(dir)).toBe('vue');
  });

  it('detects vue', () => {
    const dir = project({ dependencies: { vue: '3.4.0' } });
    expect(detectProjectFramework(dir)).toBe('vue');
  });

  it('detects angular', () => {
    const dir = project({ dependencies: { '@angular/core': '17.0.0' } });
    expect(detectProjectFramework(dir)).toBe('angular');
  });

  it('returns null for a non-frontend project', () => {
    const dir = project({ dependencies: { express: '4.0.0' } });
    expect(detectProjectFramework(dir)).toBeNull();
  });

  it('returns null when package.json is missing', () => {
    const dir = mkdtempSync(join(root, 'empty-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    expect(detectProjectFramework(dir)).toBeNull();
  });

  it('fails open to null on malformed package.json', () => {
    const dir = mkdtempSync(join(root, 'bad-'));
    writeFileSync(join(dir, 'package.json'), '{ not json', 'utf8');
    expect(detectProjectFramework(dir)).toBeNull();
  });
});
