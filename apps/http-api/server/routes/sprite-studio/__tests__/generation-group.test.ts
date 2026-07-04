/**
 * toGenerationGroupDto — the Frames-browser group header projection. Resolves
 * the batch's animation id from the job request snapshot, tolerates a deleted
 * animation (animationName null, group kept), and buckets job_id-less versions
 * as 'manual'.
 */
import { describe, expect, it } from 'vitest';
import { toGenerationGroupDto } from '../mappers.js';

const group = (jobId: number | null, versionIds: number[]) => ({
  jobId,
  versionIds,
  createdAt: '2026-07-03T10:00:00.000Z',
});

describe('toGenerationGroupDto', () => {
  it('resolves a frame-pack batch to its animation', () => {
    const job = { kind: 'generate', user_intent: 'walk cycle', request: { animation_id: 5, n: 6 } };
    const dto = toGenerationGroupDto(group(40, [11, 12, 13, 14, 15, 16]), job, 'idle', true);
    expect(dto).toMatchObject({
      jobId: 40,
      kind: 'generate',
      animationId: 5,
      animationName: 'idle',
      prompt: 'walk cycle',
      frameCount: 6,
      hasSheet: true,
    });
    expect(dto.versionIds).toEqual([11, 12, 13, 14, 15, 16]);
  });

  it('keeps the group when the animation was deleted (animationName null)', () => {
    const job = { kind: 'generate', user_intent: 'x', request: { animation_id: 99 } };
    const dto = toGenerationGroupDto(group(41, [20]), job, null, false);
    expect(dto.animationId).toBe(99);
    expect(dto.animationName).toBeNull();
    expect(dto.frameCount).toBe(1);
    expect(dto.hasSheet).toBe(false);
  });

  it('buckets job_id-less versions as a manual group', () => {
    const dto = toGenerationGroupDto(group(null, [1, 2]), null, null, false);
    expect(dto.jobId).toBeNull();
    expect(dto.kind).toBe('manual');
    expect(dto.animationId).toBeNull();
    expect(dto.prompt).toBeNull();
  });
});
