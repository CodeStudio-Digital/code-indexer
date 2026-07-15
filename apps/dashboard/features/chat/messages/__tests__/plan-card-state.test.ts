import { describe, expect, it } from 'vitest';
import {
  derivePlanResolution,
  persistedPlanDisplayStatus,
} from '../plan-card-state.js';

describe('derivePlanResolution', () => {
  it('recognizes approval', () => {
    expect(derivePlanResolution({
      content: 'Plan approved by user. You may now proceed with mutating tools.',
      isError: false,
    })).toBe('approved');
  });

  it('recognizes the new revision result', () => {
    expect(derivePlanResolution({
      content: 'Plan revision requested by user. Feedback: add tests',
      isError: false,
    })).toBe('revision_requested');
  });

  it('keeps legacy non-error rejection text as a revision request', () => {
    expect(derivePlanResolution({
      content: 'Plan rejected by user. Feedback: add tests',
      isError: false,
    })).toBe('revision_requested');
  });

  it.each([
    'Plan rejected by user. Planning review ended.',
    'Plan review aborted by user.',
  ])('recognizes explicit user rejection: %s', (content) => {
    expect(derivePlanResolution({ content, isError: true })).toBe('rejected');
  });

  it('never attributes a validation/tool failure to the user', () => {
    expect(derivePlanResolution({
      content: 'Hold on — this plan presents more than one viable approach.',
      isError: true,
    })).toBe('validation_error');
  });

  it('treats an unknown successful shape as unclassified validation failure', () => {
    expect(derivePlanResolution({ content: 'unexpected result', isError: false })).toBe('validation_error');
  });
});

describe('persistedPlanDisplayStatus', () => {
  it('maps the legacy persistence vocabulary without a migration', () => {
    expect(persistedPlanDisplayStatus('pending')).toBe('pending');
    expect(persistedPlanDisplayStatus('approved')).toBe('approved');
    expect(persistedPlanDisplayStatus('rejected')).toBe('revision_requested');
    expect(persistedPlanDisplayStatus('aborted')).toBe('rejected');
  });
});
