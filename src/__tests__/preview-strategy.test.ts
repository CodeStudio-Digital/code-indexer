import { describe, it, expect } from 'vitest';
import {
  PREVIEW_STRATEGIES,
  inferPreviewStrategy,
  isPreviewStrategy,
} from '@mcp/services/sandbox/preview-strategy.js';

describe('PreviewStrategy', () => {
  describe('isPreviewStrategy', () => {
    it('accepts canonical values', () => {
      for (const s of PREVIEW_STRATEGIES) {
        expect(isPreviewStrategy(s)).toBe(true);
      }
    });

    it('rejects garbage', () => {
      expect(isPreviewStrategy('proxy')).toBe(false);
      expect(isPreviewStrategy('direct')).toBe(false);
      expect(isPreviewStrategy('')).toBe(false);
      expect(isPreviewStrategy(null)).toBe(false);
      expect(isPreviewStrategy(undefined)).toBe(false);
      expect(isPreviewStrategy(42)).toBe(false);
    });
  });

  describe('inferPreviewStrategy', () => {
    it('returns proxy-prefix for owned mounts with default image', () => {
      expect(inferPreviewStrategy({ stack: 'react-ts', mountKind: 'owned' })).toBe('proxy-prefix');
    });

    it('returns port-direct for external mounts', () => {
      expect(inferPreviewStrategy({ stack: 'react-ts', mountKind: 'external' })).toBe('port-direct');
    });

    it('returns port-direct for project Dockerfiles', () => {
      expect(
        inferPreviewStrategy({ stack: 'react-ts', mountKind: 'owned', fromProjectDockerfile: true }),
      ).toBe('port-direct');
    });

    it('returns port-direct when external takes precedence over Dockerfile', () => {
      expect(
        inferPreviewStrategy({ mountKind: 'external', fromProjectDockerfile: true }),
      ).toBe('port-direct');
    });

    it('defaults to proxy-prefix when no signals are present', () => {
      expect(inferPreviewStrategy({})).toBe('proxy-prefix');
    });

    it('is stable for repeated inputs', () => {
      const input = { stack: 'vue-ts', mountKind: 'owned' as const };
      expect(inferPreviewStrategy(input)).toBe(inferPreviewStrategy(input));
    });
  });
});
