import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectRunners } from '../detect.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'detect-py-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function pyGroup(opts?: Parameters<typeof detectRunners>[1]) {
  return detectRunners(root, opts).groups.find((g) => g.manager === 'pip' || g.manager === 'poetry');
}

describe('detectPython', () => {
  it('returns no python group when there is no manifest', () => {
    expect(pyGroup()).toBeUndefined();
  });

  it('detects pip from requirements.txt', () => {
    writeFileSync(join(root, 'requirements.txt'), 'requests\n');
    const g = pyGroup();
    expect(g?.manager).toBe('pip');
    expect(g?.installCommand).toBe('pip install -r requirements.txt');
    expect(g?.installNeeded).toBe(true); // no virtualenv
  });

  it('detects poetry from poetry.lock', () => {
    writeFileSync(join(root, 'poetry.lock'), '');
    expect(pyGroup()?.manager).toBe('poetry');
    expect(pyGroup()?.installCommand).toBe('poetry install');
  });

  it('detects poetry from a [tool.poetry] pyproject', () => {
    writeFileSync(join(root, 'pyproject.toml'), '[tool.poetry]\nname = "x"\n');
    expect(pyGroup()?.manager).toBe('poetry');
    expect(pyGroup()?.source).toBe('pyproject.toml');
  });

  it('falls back to pip + `pip install .` for a non-poetry pyproject (no requirements.txt)', () => {
    writeFileSync(join(root, 'pyproject.toml'), '[build-system]\nrequires = ["setuptools"]\n');
    const g = pyGroup();
    expect(g?.manager).toBe('pip');
    expect(g?.installCommand).toBe('pip install .'); // not `-r requirements.txt` (would fail)
  });

  it('honours the python manager override over auto-detect', () => {
    writeFileSync(join(root, 'poetry.lock'), '');
    expect(pyGroup({ pythonManager: 'pip' })?.manager).toBe('pip');
  });

  it('uses `pip install .` when pip is forced but no requirements.txt exists', () => {
    writeFileSync(join(root, 'poetry.lock'), '');
    expect(pyGroup({ pythonManager: 'pip' })?.installCommand).toBe('pip install .');
  });

  it('marks deps installed when a virtualenv is present', () => {
    writeFileSync(join(root, 'requirements.txt'), '');
    mkdirSync(join(root, '.venv'));
    expect(pyGroup()?.installNeeded).toBe(false);
  });
});

describe('detectJs override', () => {
  it('forces the JS manager over the lockfile auto-detect', () => {
    writeFileSync(join(root, 'package.json'), '{"scripts":{"dev":"vite"}}');
    const g = detectRunners(root, { nodeManager: 'pnpm' }).groups.find((x) => x.source === 'package.json');
    expect(g?.manager).toBe('pnpm');
    expect(g?.installCommand).toBe('pnpm install');
    expect(g?.runners[0]?.command).toBe('pnpm run dev');
  });
});
