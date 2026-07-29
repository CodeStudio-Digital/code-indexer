import { describe, it, expect } from 'vitest';
import {
  buildAgentsDefaultUrl,
  buildAgentsUrl,
  parseAgentsParams,
} from '@apps/dashboard/features/agents/routing.js';

describe('agents routing', () => {
  const ROOT_ID = '00000000-0000-4000-8000-000000000007';
  const FRONT_ID = '00000000-0000-4000-8000-000000000099';

  describe('buildAgentsUrl', () => {
    it('uses "main" alias when frontId === rootId', () => {
      expect(buildAgentsUrl(ROOT_ID, ROOT_ID, 'work', 'board')).toBe(
        `/company/sessions/${ROOT_ID}/main/work/board`,
      );
    });

    it('uses "main" alias when frontId is the literal string', () => {
      expect(buildAgentsUrl(ROOT_ID, 'main', 'build', 'docs')).toBe(
        `/company/sessions/${ROOT_ID}/main/build/docs`,
      );
    });

    it('emits the opaque frontId for sub-sessions', () => {
      expect(buildAgentsUrl(ROOT_ID, FRONT_ID, 'data', 'drive')).toBe(
        `/company/sessions/${ROOT_ID}/${FRONT_ID}/data/drive`,
      );
    });
  });

  describe('buildAgentsDefaultUrl', () => {
    it('lands on Work / board for Main', () => {
      expect(buildAgentsDefaultUrl(ROOT_ID)).toBe(
        `/company/sessions/${ROOT_ID}/main/work/board`,
      );
    });
  });

  describe('parseAgentsParams', () => {
    it('parses canonical URL params', () => {
      const route = parseAgentsParams({
        rootId: ROOT_ID,
        frontId: FRONT_ID,
        zone: 'build',
        tab: 'docs',
      });
      expect(route).toEqual({
        rootId: ROOT_ID,
        frontId: FRONT_ID,
        zone: 'build',
        tab: 'docs',
      });
    });

    it('resolves "main" alias to rootId', () => {
      const route = parseAgentsParams({
        rootId: ROOT_ID,
        frontId: 'main',
        zone: 'work',
        tab: 'kanban',
      });
      expect(route?.frontId).toBe(ROOT_ID);
    });

    it('falls back to work zone when zone is unknown', () => {
      const route = parseAgentsParams({ rootId: ROOT_ID, frontId: 'main', zone: 'bogus', tab: 'board' });
      expect(route?.zone).toBe('work');
    });

    it('falls back to the zone default tab when the tab is unknown', () => {
      const route = parseAgentsParams({ rootId: ROOT_ID, frontId: 'main', zone: 'data', tab: 'totally-wrong' });
      expect(route?.zone).toBe('data');
      expect(route?.tab).toBe('drive');
    });

    it('reroutes the tab to the correct zone when zone is misaligned', () => {
      // Drive lives in `data`; asking for `work/drive` should land on `data/drive`.
      const route = parseAgentsParams({ rootId: ROOT_ID, frontId: 'main', zone: 'work', tab: 'drive' });
      expect(route?.zone).toBe('data');
      expect(route?.tab).toBe('drive');
    });

    it('returns null when rootId is missing and no fallback is given', () => {
      expect(parseAgentsParams({})).toBeNull();
    });

    it('uses the rootId fallback when params do not carry one', () => {
      const route = parseAgentsParams(
        { frontId: FRONT_ID, zone: 'work', tab: 'board' },
        ROOT_ID,
      );
      expect(route?.rootId).toBe(ROOT_ID);
      expect(route?.frontId).toBe(FRONT_ID);
    });

    it('preserves an opaque non-numeric root id', () => {
      expect(parseAgentsParams({ rootId: 'opaque-session-id' })?.rootId).toBe(
        'opaque-session-id',
      );
    });

    it('falls back frontId to rootId when frontId is blank', () => {
      const route = parseAgentsParams({ rootId: ROOT_ID, frontId: '  ' });
      expect(route?.frontId).toBe(ROOT_ID);
    });
  });
});
