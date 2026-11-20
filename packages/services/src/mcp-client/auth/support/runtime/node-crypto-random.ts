import { randomBytes, randomUUID } from 'node:crypto';
import type { RandomId } from '../ports/random-id.js';

export class NodeCryptoRandom implements RandomId {
  token(bytes: number): string {
    if (bytes <= 0) throw new Error('token bytes must be positive');
    return randomBytes(bytes).toString('hex');
  }

  uuid(): string {
    return randomUUID();
  }
}
