import { createHash } from 'node:crypto';

const DOMAIN = Buffer.from('codestudio.agent.semantic-sha256.v1\0', 'utf8');
const MAX_U32 = 0xffff_ffff;

export interface SemanticHashInput {
  schemaId: string;
  schemaVersion: number;
  canonicalBytes: Uint8Array;
}

/**
 * Hashes canonical bytes with an unambiguous schema-qualified preimage.
 * Callers remain responsible for producing canonical JSON or deterministic
 * Protobuf bytes before crossing this boundary.
 */
export function semanticSha256(input: SemanticHashInput): Uint8Array {
  const schemaId = Buffer.from(input.schemaId, 'utf8');
  if (schemaId.length === 0 || schemaId.length > MAX_U32) {
    throw new RangeError('schemaId must contain between 1 and uint32 bytes');
  }
  if (
    !Number.isSafeInteger(input.schemaVersion)
    || input.schemaVersion <= 0
    || input.schemaVersion > MAX_U32
  ) {
    throw new RangeError('schemaVersion must be a positive uint32');
  }

  const schemaIdLength = Buffer.allocUnsafe(4);
  schemaIdLength.writeUInt32BE(schemaId.length);
  const schemaVersion = Buffer.allocUnsafe(4);
  schemaVersion.writeUInt32BE(input.schemaVersion);
  const payloadLength = Buffer.allocUnsafe(8);
  payloadLength.writeBigUInt64BE(BigInt(input.canonicalBytes.byteLength));

  return createHash('sha256')
    .update(DOMAIN)
    .update(schemaIdLength)
    .update(schemaId)
    .update(schemaVersion)
    .update(payloadLength)
    .update(input.canonicalBytes)
    .digest();
}
