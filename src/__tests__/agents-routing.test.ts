import { describe, it, expect } from 'vitest';
import {
  buildAgentsDefaultUrl,
  buildAgentsUrl,
  parseAgentsParams,
} from '@apps/dashboard/features/agents/routing.js';

describe('agents routing', () => {
  describe('buildAgentsUrl', () => {
    it('uses "main" alias when frontId === rootId', () => {
      expect(buildAgentsUrl(7, 7, 'work', 'board')).toBe('/company/sessions/7/main/work/board');
    });

    it('uses "main" alias when frontId is the literal string', () => {
      expect(buildAgentsUrl(7, 'main', 'build', 'docs')).toBe('/company/sessions/7/main/build/docs');
    });

    it('emits numeric frontId for sub-sessions', () => {
      expect(buildAgentsUrl(7, 99, 'data', 'drive')).toBe('/company/sessions/7/99/data/drive');
    });
  });

  describe('buildAgentsDefaultUrl', () => {
    it('lands on Work / board for Main', () => {
      expect(buildAgentsDefaultUrl(42)).toBe('/company/sessions/42/main/work/board');
    });
  });

  describe('parseAgentsParams', () => {
    it('parses canonical URL params', () => {
      const route = parseAgentsParams({
        rootId: '42',
        frontId: '88',
        zone: 'build',
        tab: 'docs',
      });
      expect(route).toEqual({ rootId: 42, frontId: 88, zone: 'build', tab: 'docs' });
    });

    it('resolves "main" alias to rootId', () => {
      const route = parseAgentsParams({
        rootId: '42',
        frontId: 'main',
        zone: 'work',
        tab: 'kanban',
      });
      expect(route?.frontId).toBe(42);
    });

    it('falls back to work zone when zone is unknown', () => {
      const route = parseAgentsParams({ rootId: '42', frontId: 'main', zone: 'bogus', tab: 'board' });
      expect(route?.zone).toBe('work');
    });

    it('falls back to the zone default tab when the tab is unknown', () => {
      const route = parseAgentsParams({ rootId: '42', frontId: 'main', zone: 'data', tab: 'totally-wrong' });
      expect(route?.zone).toBe('data');
      expect(route?.tab).toBe('drive');
    });

    it('reroutes the tab to the correct zone when zone is misaligned', () => {
      // Drive lives in `data`; asking for `work/drive` should land on `data/drive`.
      const route = parseAgentsParams({ rootId: '42', frontId: 'main', zone: 'work', tab: 'drive' });
      expect(route?.zone).toBe('data');
      expect(route?.tab).toBe('drive');
    });

    it('returns null when rootId is missing and no fallback is given', () => {
      expect(parseAgentsParams({})).toBeNull();
    });

    it('uses the rootId fallback when params do not carry one', () => {
      const route = parseAgentsParams({ frontId: '5', zone: 'work', tab: 'board' }, 42);
      expect(route?.rootId).toBe(42);
      expect(route?.frontId).toBe(5);
    });

    it('returns null when rootId is non-numeric', () => {
      expect(parseAgentsParams({ rootId: 'abc' })).toBeNull();
    });

    it('falls back frontId to rootId when frontId is invalid', () => {
      const route = parseAgentsParams({ rootId: '42', frontId: 'not-a-number' });
      expect(route?.frontId).toBe(42);
    });
  });
});
