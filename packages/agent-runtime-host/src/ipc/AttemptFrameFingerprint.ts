import type { ValidatedOpaqueAttemptFrame } from './AttemptFrame.js';

export function attemptFrameFingerprint(
  validated: ValidatedOpaqueAttemptFrame,
): string {
  return Buffer.from(validated.envelopeDigest).toString('hex');
}
