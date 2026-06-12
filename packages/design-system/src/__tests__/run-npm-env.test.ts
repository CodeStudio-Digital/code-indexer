import { afterEach, describe, expect, it } from 'vitest';
import { cleanNpmEnv } from '../run-npm.js';

// Snapshot/restore the two vars we poke so the suite never leaks state.
const SAVED = {
  NODE_OPTIONS: process.env.NODE_OPTIONS,
  ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
};
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('cleanNpmEnv', () => {
  it('strips the dev-runner injection inherited from process.env (session 979 regression)', () => {
    process.env.NODE_OPTIONS = '--import tsx';
    process.env.ELECTRON_RUN_AS_NODE = '1';
    const env = cleanNpmEnv();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('strips them even when passed via overrides', () => {
    const env = cleanNpmEnv({ NODE_OPTIONS: '--import tsx', ELECTRON_RUN_AS_NODE: '1' });
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('keeps everything else and applies overrides', () => {
    process.env.NODE_OPTIONS = '--import tsx';
    const env = cleanNpmEnv({ MY_FLAG: 'on' });
    expect(env.PATH ?? env.Path).toBeTruthy(); // inherited
    expect(env.MY_FLAG).toBe('on');
  });

  it('does not mutate process.env', () => {
    process.env.NODE_OPTIONS = '--import tsx';
    cleanNpmEnv();
    expect(process.env.NODE_OPTIONS).toBe('--import tsx');
  });
});
