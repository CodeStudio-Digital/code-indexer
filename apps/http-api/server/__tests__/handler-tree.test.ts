import { describe, it, expect } from 'vitest';
import {
  type HandlerLeaf,
  decodeInvoke,
  isStreamingLeaf,
  normalizeRouteKey,
  serializeError,
  walkHandlers,
} from '../handler-tree.js';
import { ApiError } from '@mcp/api-bus';

/**
 * This module is the shared contract between the Electron `ipcMain` host and
 * the future `utilityProcess` host. Both derive channel names from the same
 * walk, and the renderer's preload builds the SAME strings from its proxy
 * access path — so a change in naming here silently breaks every call.
 */
describe('walkHandlers', () => {
  const collect = (handlers: Record<string, unknown>): HandlerLeaf[] => {
    const seen: HandlerLeaf[] = [];
    walkHandlers(handlers, (leaf) => seen.push(leaf));
    return seen;
  };

  it('encodes the access path as a colon-joined channel', () => {
    const leaves = collect({ coder: { sessions: { list: () => 1 } }, files: { read: () => 2 } });
    expect(leaves.map((l) => l.channel).sort()).toEqual(['api:coder:sessions:list', 'api:files:read']);
    expect(leaves.find((l) => l.channel === 'api:files:read')?.path).toEqual(['files', 'read']);
  });

  it('returns every channel it bound', () => {
    const bound = walkHandlers({ a: { b: () => 0 }, c: () => 0 }, () => {});
    expect(bound).toEqual(new Set(['api:a:b', 'api:c']));
  });

  it('passes the leaf function through untouched', () => {
    const fn = () => 'value';
    const [leaf] = collect({ ns: { method: fn } });
    expect(leaf.fn).toBe(fn);
  });

  it('ignores null and non-function, non-object leaves', () => {
    expect(collect({ nope: null, num: 3, str: 'x' })).toEqual([]);
  });

  it('marks streaming leaves and leaves the rest one-shot', () => {
    const leaves = collect({
      coder: { stream: { sendMessage: () => 0 }, sessions: { list: () => 0 } },
      terminal: { output: () => 0, listShells: () => 0 },
      projects: { indexStream: () => 0, get: () => 0 },
    });
    const streaming = leaves.filter((l) => l.streaming).map((l) => l.channel).sort();
    expect(streaming).toEqual([
      'api:coder:stream:sendMessage',
      'api:projects:indexStream',
      'api:terminal:output',
    ]);
  });
});

describe('isStreamingLeaf', () => {
  it.each([
    [['projects'], 'indexStream', true],
    [['coder', 'stream'], 'anything', true],
    [['terminal'], 'output', true],
    [['runner'], 'events', true],
    [['debug'], 'events', true],
    [['runtime'], 'install', true],
    [['runtime'], 'installPeclExtension', true],
    [['company'], 'stream', true],
    // Near-misses that must stay one-shot.
    [['terminal'], 'listShells', false],
    [['runtime'], 'list', false],
    [['company'], 'agents', false],
    [['coder'], 'stream', false], // `stream` as a LEAF of coder, not the sub-namespace
  ])('%j.%s → %s', (path, name, expected) => {
    expect(isStreamingLeaf(path as string[], name as string)).toBe(expected);
  });
});

describe('decodeInvoke', () => {
  it('unwraps a cancellable envelope', () => {
    expect(decodeInvoke({ __mcpInvokeV1: true, requestId: 'r1', payload: { a: 1 } }))
      .toEqual({ payload: { a: 1 }, requestId: 'r1' });
  });

  it('passes a bare payload through, so an older client still works', () => {
    expect(decodeInvoke({ a: 1 })).toEqual({ payload: { a: 1 } });
    expect(decodeInvoke(null)).toEqual({ payload: null });
    // Envelope shape without a string requestId is NOT an envelope.
    expect(decodeInvoke({ __mcpInvokeV1: true, payload: 'x' }))
      .toEqual({ payload: { __mcpInvokeV1: true, payload: 'x' } });
  });
});

describe('normalizeRouteKey', () => {
  it('collapses numeric catalog IDs and UUID operational IDs', () => {
    expect(normalizeRouteKey('/api/projects/10/git/status')).toBe('/api/projects/:id/git/status');
    expect(normalizeRouteKey('/api/projects/123/git/status')).toBe('/api/projects/:id/git/status');
    expect(normalizeRouteKey(
      '/api/coder/sessions/11111111-1111-4111-8111-111111111111',
    )).toBe('/api/coder/sessions/:id');
    expect(normalizeRouteKey(
      '/api/coder/sessions/11111111-1111-4111-8111-111111111111/snapshot/22222222-2222-4222-8222-222222222222',
    )).toBe('/api/coder/sessions/:id/snapshot/:id');
    expect(normalizeRouteKey(
      '/api/sessions/trash/11111111-1111-4111-8111-111111111111-2026-07-27T12-34-56-789Z-22222222-2222-4222-8222-222222222222/restore',
    )).toBe('/api/sessions/trash/:id/restore');
  });

  it('leaves non-numeric segments alone', () => {
    expect(normalizeRouteKey('/api/projects/semantic/status')).toBe('/api/projects/semantic/status');
    // A version-like segment is not a bare number, so it must survive.
    expect(normalizeRouteKey('/api/v1/health')).toBe('/api/v1/health');
    expect(normalizeRouteKey('/')).toBe('/');
  });
});

describe('serializeError', () => {
  it('preserves code, status and details for an ApiError', () => {
    const err = new ApiError('ssh_host_key_unknown', 409, 'unknown host key', { fingerprint: 'ab:cd' });
    expect(serializeError(err)).toEqual({
      message: 'unknown host key',
      code: 'ssh_host_key_unknown',
      status: 409,
      details: { fingerprint: 'ab:cd' },
    });
  });

  it('reduces a plain Error to its message and stringifies anything else', () => {
    expect(serializeError(new Error('boom'))).toEqual({ message: 'boom' });
    expect(serializeError('boom')).toEqual({ message: 'boom' });
    expect(serializeError(undefined)).toEqual({ message: 'undefined' });
  });
});
