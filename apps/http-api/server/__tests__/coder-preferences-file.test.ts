import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODER_PREFERENCES_RELATIVE_PATH,
  CoderPreferencesFile,
} from '../coder-preferences-file.js';

let temporaryRoot: string | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = null;
  }
});

async function fixture(): Promise<CoderPreferencesFile> {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-coder-preferences-'));
  return CoderPreferencesFile.fromDataDir(temporaryRoot);
}

describe('CoderPreferencesFile', () => {
  it('atomically persists and reloads the last selected provider/model', async () => {
    const preferences = await fixture();

    await expect(preferences.getLastSelectedModel()).resolves.toBeNull();
    await preferences.setLastSelectedModel('copilot', 'claude-sonnet-4.6');

    const persisted = JSON.parse(
      await readFile(
        join(temporaryRoot!, CODER_PREFERENCES_RELATIVE_PATH),
        'utf8',
      ),
    ) as {
      schema_version: number;
      last_selected_model: {
        provider: string;
        model: string;
        updated_at: string;
      };
    };
    expect(persisted).toMatchObject({
      schema_version: 1,
      last_selected_model: {
        provider: 'copilot',
        model: 'claude-sonnet-4.6',
      },
    });
    expect(Date.parse(persisted.last_selected_model.updated_at)).not.toBeNaN();

    const reloaded = CoderPreferencesFile.fromDataDir(temporaryRoot!);
    await expect(reloaded.getLastSelectedModel()).resolves.toEqual({
      provider: 'copilot',
      model: 'claude-sonnet-4.6',
    });
  });

  it('serializes concurrent updates so the last selection wins', async () => {
    const preferences = await fixture();

    await Promise.all([
      preferences.setLastSelectedModel('zai', 'glm-5.2'),
      preferences.setLastSelectedModel('openai', 'gpt-5.4'),
    ]);

    await expect(preferences.getLastSelectedModel()).resolves.toEqual({
      provider: 'openai',
      model: 'gpt-5.4',
    });
    const reloaded = CoderPreferencesFile.fromDataDir(temporaryRoot!);
    await expect(reloaded.getLastSelectedModel()).resolves.toEqual({
      provider: 'openai',
      model: 'gpt-5.4',
    });
  });

  it('ignores a corrupt preference file instead of blocking session creation', async () => {
    const preferences = await fixture();
    await preferences.setLastSelectedModel('zai', 'glm-5.2');
    await writeFile(preferences.path, '{broken', 'utf8');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const reloaded = new CoderPreferencesFile(preferences.path);
    await expect(reloaded.getLastSelectedModel()).resolves.toBeNull();
    expect(warning).toHaveBeenCalledOnce();
  });
});
