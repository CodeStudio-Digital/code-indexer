import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolOutputStore } from '../tool-output-store.js';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ToolOutputStore availability', () => {
  it('only reports recovery availability after a snapshot exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-tool-output-'));
    created.push(root);
    const store = new ToolOutputStore(root, 1);

    expect(store.hasOutputs()).toBe(false);
    const id = store.put('complete output');
    expect(id).toMatch(/^[a-f0-9]{12}$/);
    expect(store.hasOutputs()).toBe(true);
  });
});
