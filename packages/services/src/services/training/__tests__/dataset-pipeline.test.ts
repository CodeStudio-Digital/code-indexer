import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseExampleJson } from '../teacher-client.js';
import { JsonlWriter, datasetPaths } from '../jsonl-export.js';
import { getProfile, listProfiles } from '../stack-profiles.js';
import { fetchShadcnBlockSeeds } from '../seed-shadcn.js';
import { listProjectFileSeeds } from '../seed-files.js';
import { getProfile as profileFor } from '../stack-profiles.js';
import { writeMissingModuleStubs } from '../validator-stubs.js';
import { mkdir, writeFile } from 'node:fs/promises';

describe('parseExampleJson', () => {
  it('parses a bare JSON object', () => {
    const r = parseExampleJson('{"instruction":"do x","input":"","output":"code"}');
    expect(r.instruction).toBe('do x');
    expect(r.output).toBe('code');
  });

  it('tolerates code fences and surrounding prose', () => {
    const raw = 'Sure!\n```json\n{"instruction":"a","output":"b"}\n```\nDone.';
    expect(parseExampleJson(raw).output).toBe('b');
  });

  it('throws when required fields are missing', () => {
    expect(() => parseExampleJson('{"input":"x"}')).toThrow();
  });
});

describe('stack profiles', () => {
  it('exposes react-shadcn-vite with a sandbox + visual gate', () => {
    const p = getProfile('react-shadcn-vite');
    expect(p.sandbox).toBe('shadcn-vite');
    expect(p.visualGateCapable).toBe(true);
    expect(p.validatorCmds.some((c) => c.cmd.includes('vite build'))).toBe(true);
  });

  it('ships multiple languages', () => {
    const ids = listProfiles().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['react', 'angular', 'python', 'go']));
  });

  it('throws on unknown profile', () => {
    expect(() => getProfile('cobol')).toThrow(/Unknown stack profile/);
  });
});

describe('fetchShadcnBlockSeeds (MCP-backed)', () => {
  const longCode = `export function X(){ return <div>${'a'.repeat(100)}</div>; }`;

  it('parses get_block/get_component files into shadcn-block seeds', async () => {
    const call = async () => JSON.stringify({ files: { 'a.tsx': longCode } });
    const seeds = await fetchShadcnBlockSeeds(call, 2);
    expect(seeds.length).toBe(2);
    expect(seeds[0].source).toBe('shadcn-block');
    expect(seeds[0].body).toContain('export function X');
  });

  it('respects the limit', async () => {
    const call = async () => JSON.stringify({ files: { 'a.tsx': longCode } });
    expect((await fetchShadcnBlockSeeds(call, 1)).length).toBe(1);
  });

  it('is tolerant: MCP errors yield no seeds, not a throw', async () => {
    const call = async () => { throw new Error('GitHub API down'); };
    await expect(fetchShadcnBlockSeeds(call, 3)).resolves.toEqual([]);
  });

  it('skips too-short payloads', async () => {
    const call = async () => JSON.stringify({ files: { 'a.tsx': 'x' } });
    expect((await fetchShadcnBlockSeeds(call, 3)).length).toBe(0);
  });
});

describe('listProjectFileSeeds (raw FS, no index)', () => {
  it('reads matching files from disk and ignores node_modules', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fsseed-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(dir, 'src', 'Comp.tsx'), 'import React from "react";\nexport const X = () => <div/>;');
    await writeFile(join(dir, 'src', 'notes.md'), '# not code');
    await writeFile(join(dir, 'node_modules', 'pkg', 'Dep.tsx'), 'import React from "react";');

    const seeds = await listProjectFileSeeds(dir, profileFor('react-shadcn-vite'), 10);
    expect(seeds.length).toBe(1);
    expect(seeds[0].source).toBe('project');
    expect(seeds[0].filePath).toContain('Comp.tsx');
    expect(seeds[0].body).toContain('export const X');
  });

  it('respects the limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fsseed2-'));
    await writeFile(join(dir, 'a.tsx'), 'import React from "react";\nexport const A=()=><i/>;');
    await writeFile(join(dir, 'b.tsx'), 'import React from "react";\nexport const B=()=><i/>;');
    expect((await listProjectFileSeeds(dir, profileFor('react-shadcn-vite'), 1)).length).toBe(1);
  });
});

describe('writeMissingModuleStubs', () => {
  it('stubs only the imports that do not resolve in the sandbox', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stub-'));
    await mkdir(join(dir, 'node_modules', 'react'), { recursive: true });
    await mkdir(join(dir, 'src', 'components', 'ui'), { recursive: true });
    await writeFile(join(dir, 'src', 'components', 'ui', 'card.tsx'), 'export const Card = 1;');

    const code = [
      "import React from 'react';",
      "import { Card } from '@/components/ui/card';",
      "import { Settings } from 'lucide-react';",
      "import { Foo } from '@/components/ui/foo';",
    ].join('\n');

    const stubPath = await writeMissingModuleStubs(dir, code);
    expect(stubPath).toBeTruthy();
    const stub = await readFile(stubPath!, 'utf-8');
    expect(stub).toContain("declare module 'lucide-react';");
    expect(stub).toContain("declare module '@/components/ui/foo';");
    expect(stub).not.toContain("'react'");
    expect(stub).not.toContain("@/components/ui/card");
  });

  it('returns null when everything resolves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stub2-'));
    await mkdir(join(dir, 'node_modules', 'react'), { recursive: true });
    expect(await writeMissingModuleStubs(dir, "import 'react';")).toBeNull();
  });
});

describe('JsonlWriter', () => {
  it('routes holdout vs train into separate files in chat format', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsonl-test-'));
    const paths = datasetPaths(dir, 7);
    const writer = new JsonlWriter(paths);

    await writer.append({ instruction: 'task', input: 'ctx', output: 'sol' }, false);
    await writer.append({ instruction: 'h', input: '', output: 'ho' }, true);

    const train = await readFile(paths.trainPath, 'utf-8');
    const holdout = await readFile(paths.holdoutPath, 'utf-8');
    const trainObj = JSON.parse(train.trim());
    expect(trainObj.messages[0]).toEqual({ role: 'user', content: 'task\n\nctx' });
    expect(trainObj.messages[1]).toEqual({ role: 'assistant', content: 'sol' });
    expect(JSON.parse(holdout.trim()).messages[0].content).toBe('h');
  });
});
