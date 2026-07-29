/**
 * toGenerationGroupDto — the Frames-browser group header projection. Resolves
 * the batch's animation id from the job request snapshot, tolerates a deleted
 * animation (animationName null, group kept), and buckets job_id-less versions
 * as 'manual'.
 */
import { describe, expect, it } from 'vitest';
import { toGenerationGroupDto } from '../mappers.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const group = (jobId: string | null, versionIds: string[]) => ({
  jobId,
  versionIds,
  createdAt: '2026-07-03T10:00:00.000Z',
});

describe('toGenerationGroupDto', () => {
  it('resolves a frame-pack batch to its animation', () => {
    const job = { kind: 'generate', user_intent: 'walk cycle', request: { animation_id: id(5), n: 6 } };
    const versions = [11, 12, 13, 14, 15, 16].map(id);
    const dto = toGenerationGroupDto(group(id(40), versions), job, 'idle', true);
    expect(dto).toMatchObject({
      jobId: id(40),
      kind: 'generate',
      animationId: id(5),
      animationName: 'idle',
      prompt: 'walk cycle',
      frameCount: 6,
      hasSheet: true,
    });
    expect(dto.versionIds).toEqual(versions);
  });

  it('keeps the group when the animation was deleted (animationName null)', () => {
    const job = { kind: 'generate', user_intent: 'x', request: { animation_id: id(99) } };
    const dto = toGenerationGroupDto(group(id(41), [id(20)]), job, null, false);
    expect(dto.animationId).toBe(id(99));
    expect(dto.animationName).toBeNull();
    expect(dto.frameCount).toBe(1);
    expect(dto.hasSheet).toBe(false);
  });

  it('buckets job_id-less versions as a manual group', () => {
    const dto = toGenerationGroupDto(group(null, [id(1), id(2)]), null, null, false);
    expect(dto.jobId).toBeNull();
    expect(dto.kind).toBe('manual');
    expect(dto.animationId).toBeNull();
    expect(dto.prompt).toBeNull();
  });
});
