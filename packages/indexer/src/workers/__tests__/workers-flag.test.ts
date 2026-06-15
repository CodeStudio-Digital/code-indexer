import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isIndexWorkersEnabled } from '../indexJob/client.js';

const KEY = 'MCP_INDEX_WORKERS';
let saved: string | undefined;

beforeEach(() => { saved = process.env[KEY]; });
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe('isIndexWorkersEnabled (default ON, opt-out)', () => {
  it.each([
    [undefined, true],   // unset → ON (the old default-OFF left the pool dormant)
    ['', true],
    ['  ', true],
    ['1', true],
    ['4', true],         // numeric also sizes the pool
    ['on', true],
    ['true', true],
    ['0', false],
    ['off', false],
    ['OFF', false],
    ['false', false],
    [' false ', false],
  ])('%j → %s', (value, expected) => {
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    expect(isIndexWorkersEnabled()).toBe(expected);
  });
});
