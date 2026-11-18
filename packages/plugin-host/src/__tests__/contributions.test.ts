import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseAppManifest } from '@mcp/plugin-sdk';
import { buildContributions } from '../apply/contributions.js';
import { createAsyncActivationCheck } from '../activation.js';

describe('buildContributions', () => {
  it('reads each activation input once per checkout request, and observes later edits', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'activation-'));
    const read = vi.spyOn(fs, 'readFile');
    const list = vi.spyOn(fs, 'readdir');
    try {
      await fs.writeFile(join(root, 'package.json'), '{"devDependencies":{"vite":"*"}}');
      const check = createAsyncActivationCheck(root);
      const rule = { whenFiles: ['*.csproj'], whenPackageDep: ['vite'] };
      expect(await Promise.all([check(rule), check(rule)])).toEqual([true, true]);
      expect(read).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledTimes(1);
      await fs.writeFile(join(root, 'package.json'), '{}');
      expect(await createAsyncActivationCheck(root)(rule)).toBe(false);
      await fs.writeFile(join(root, 'Game.csproj'), '');
      expect(await createAsyncActivationCheck(root)(rule)).toBe(true);
      expect(await createAsyncActivationCheck(null)(rule)).toBe(false);
      expect(await createAsyncActivationCheck(null)(undefined)).toBe(true);
    } finally {
      read.mockRestore();
      list.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('normalizes a trusted language server into the installed snapshot', () => {
    const app = parseAppManifest({
      languageServers: [{
        id: 'angular-language-server',
        label: 'Angular Language Service',
        languages: ['typescript', 'html'],
        activation: { whenFiles: ['angular.json'], whenPackageDep: ['@angular/core'] },
        install: { kind: 'npm', package: '@angular/language-server', version: '21.2.18' },
        entryRelPath: 'node_modules/@angular/language-server/index.js',
        args: [],
        launchKind: 'angular',
        routing: { mode: 'overlay', priority: 100 },
        sizeLabel: '~35 MB',
      }],
    }, { trustFirstParty: true });

    const snapshot = buildContributions(app);
    expect(snapshot?.languageServers).toEqual(app.languageServers);
    expect(snapshot?.tools).toEqual([]);
    expect(snapshot?.worker).toBeNull();
  });
});
