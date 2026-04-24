import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectManifest } from '../core/sandbox/manifest-detector/detect.js';

describe('detectManifest', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-manifest-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null for a directory with no manifest', () => {
    const dir = mkdirSyncUnder(root, 'empty');
    expect(detectManifest(dir)).toBeNull();
  });

  it('returns null for a non-existent path', () => {
    expect(detectManifest(join(root, 'does-not-exist'))).toBeNull();
  });

  it('returns null for relative paths', () => {
    expect(detectManifest('./relative')).toBeNull();
  });

  describe('node', () => {
    it('detects package.json with dev script and npm lockfile', () => {
      const dir = mkdirSyncUnder(root, 'node-dev');
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'demo',
          scripts: { dev: 'vite', build: 'vite build' },
        }),
      );
      writeFileSync(join(dir, 'package-lock.json'), '{}');
      const info = detectManifest(dir);
      expect(info).toMatchObject({
        kind: 'node',
        packageName: 'demo',
        packageManager: 'npm',
        devScriptName: 'dev',
        hasNodeModules: false,
      });
      expect(info && info.kind === 'node' && info.scripts.dev).toBe('vite');
    });

    it('picks "start" when no "dev" exists', () => {
      const dir = mkdirSyncUnder(root, 'node-start');
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { start: 'node server.js' } }),
      );
      const info = detectManifest(dir);
      expect(info?.kind).toBe('node');
      expect((info as { devScriptName: string }).devScriptName).toBe('start');
    });

    it('returns null devScriptName when no candidate script exists', () => {
      const dir = mkdirSyncUnder(root, 'node-no-dev');
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { build: 'tsc', lint: 'eslint .' } }),
      );
      const info = detectManifest(dir);
      expect((info as { devScriptName: unknown }).devScriptName).toBeNull();
    });

    it('detects pnpm and yarn from lockfiles', () => {
      const pnpmDir = mkdirSyncUnder(root, 'node-pnpm');
      writeFileSync(join(pnpmDir, 'package.json'), '{"name":"a","scripts":{"dev":"x"}}');
      writeFileSync(join(pnpmDir, 'pnpm-lock.yaml'), '');
      expect((detectManifest(pnpmDir) as { packageManager: string }).packageManager).toBe('pnpm');

      const yarnDir = mkdirSyncUnder(root, 'node-yarn');
      writeFileSync(join(yarnDir, 'package.json'), '{"name":"a","scripts":{"dev":"x"}}');
      writeFileSync(join(yarnDir, 'yarn.lock'), '');
      expect((detectManifest(yarnDir) as { packageManager: string }).packageManager).toBe('yarn');
    });

    it('sets hasNodeModules when the folder exists', () => {
      const dir = mkdirSyncUnder(root, 'node-modules');
      writeFileSync(join(dir, 'package.json'), '{"scripts":{"dev":"x"}}');
      mkdirSync(join(dir, 'node_modules'));
      expect((detectManifest(dir) as { hasNodeModules: boolean }).hasNodeModules).toBe(true);
    });

    it('returns null when package.json is malformed', () => {
      const dir = mkdirSyncUnder(root, 'node-broken');
      writeFileSync(join(dir, 'package.json'), '{ not-json');
      expect(detectManifest(dir)).toBeNull();
    });

    it('prefers node over ruby when both manifests coexist', () => {
      const dir = mkdirSyncUnder(root, 'node-and-ruby');
      writeFileSync(join(dir, 'package.json'), '{"scripts":{"dev":"vite"}}');
      writeFileSync(join(dir, 'Gemfile'), "gem 'rails'");
      expect(detectManifest(dir)?.kind).toBe('node');
    });
  });

  describe('python', () => {
    it('detects pyproject.toml with fastapi and a main.py entry', () => {
      const dir = mkdirSyncUnder(root, 'py-fastapi');
      writeFileSync(
        join(dir, 'pyproject.toml'),
        '[project]\nname = "api"\ndependencies = ["fastapi>=0.100"]\n',
      );
      writeFileSync(join(dir, 'main.py'), 'app = None\n');
      const info = detectManifest(dir);
      expect(info).toMatchObject({
        kind: 'python',
        framework: 'fastapi',
        entry: 'main:app',
      });
    });

    it('falls back to requirements.txt for framework detection', () => {
      const dir = mkdirSyncUnder(root, 'py-flask');
      writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
      writeFileSync(join(dir, 'requirements.txt'), 'flask==3.0\n');
      writeFileSync(join(dir, 'app.py'), 'app = None\n');
      const info = detectManifest(dir);
      expect((info as { framework: string }).framework).toBe('flask');
      expect((info as { entry: string }).entry).toBe('app:app');
    });

    it('returns entry=null when no common entry file exists', () => {
      const dir = mkdirSyncUnder(root, 'py-no-entry');
      writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
      expect((detectManifest(dir) as { entry: unknown }).entry).toBeNull();
    });
  });

  describe('go', () => {
    it('parses module name and detects main.go', () => {
      const dir = mkdirSyncUnder(root, 'go-main');
      writeFileSync(join(dir, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
      writeFileSync(join(dir, 'main.go'), 'package main\n');
      const info = detectManifest(dir);
      expect(info).toMatchObject({
        kind: 'go',
        moduleName: 'example.com/demo',
        hasMainGo: true,
      });
    });

    it('returns empty moduleName when go.mod lacks module line', () => {
      const dir = mkdirSyncUnder(root, 'go-empty');
      writeFileSync(join(dir, 'go.mod'), 'go 1.22\n');
      expect((detectManifest(dir) as { moduleName: string }).moduleName).toBe('');
    });
  });

  describe('rust', () => {
    it('parses package name and no bins', () => {
      const dir = mkdirSyncUnder(root, 'rs-plain');
      writeFileSync(
        join(dir, 'Cargo.toml'),
        '[package]\nname = "webserver"\nversion = "0.1.0"\n',
      );
      const info = detectManifest(dir);
      expect(info).toMatchObject({
        kind: 'rust',
        packageName: 'webserver',
        binaries: [],
      });
    });

    it('collects [[bin]] names', () => {
      const dir = mkdirSyncUnder(root, 'rs-bins');
      writeFileSync(
        join(dir, 'Cargo.toml'),
        [
          '[package]',
          'name = "multi"',
          'version = "0.1.0"',
          '',
          '[[bin]]',
          'name = "api"',
          'path = "src/bin/api.rs"',
          '',
          '[[bin]]',
          'name = "worker"',
          'path = "src/bin/worker.rs"',
        ].join('\n'),
      );
      expect((detectManifest(dir) as { binaries: string[] }).binaries).toEqual(['api', 'worker']);
    });
  });

  describe('ruby', () => {
    it('detects rails from Gemfile', () => {
      const dir = mkdirSyncUnder(root, 'rb-rails');
      writeFileSync(join(dir, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rails', '7.1'\n");
      expect(detectManifest(dir)).toMatchObject({ kind: 'ruby', framework: 'rails' });
    });

    it('detects sinatra with double quotes', () => {
      const dir = mkdirSyncUnder(root, 'rb-sinatra');
      writeFileSync(join(dir, 'Gemfile'), 'gem "sinatra"\n');
      expect((detectManifest(dir) as { framework: string }).framework).toBe('sinatra');
    });

    it('returns unknown framework when no matching gem', () => {
      const dir = mkdirSyncUnder(root, 'rb-unknown');
      writeFileSync(join(dir, 'Gemfile'), "gem 'pry'\n");
      expect((detectManifest(dir) as { framework: string }).framework).toBe('unknown');
    });
  });
});

function mkdirSyncUnder(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
