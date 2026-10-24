import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { semanticSha256 } from '../ipc/semantic-hash.js';

const fixtures = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../agent-runtime-contracts/fixtures/v1',
);

describe('semanticSha256', () => {
  it('matches the shared schema-qualified golden preimage', () => {
    const expectedPreimage = readFileSync(
      resolve(fixtures, 'semantic-hash-preimage.hex'),
      'utf8',
    ).trim();
    const expectedHash = readFileSync(
      resolve(fixtures, 'semantic-hash.sha256'),
      'utf8',
    ).trim();
    const canonicalBytes = Buffer.from('{"a":1,"b":"α"}', 'utf8');
    const actual = semanticSha256({
      schemaId: 'codestudio.agent.fixture.v1',
      schemaVersion: 7,
      canonicalBytes,
    });

    expect(Buffer.from(actual).toString('hex')).toBe(expectedHash);
    const independent = actual.slice();
    independent.fill(0);
    expect(Buffer.from(actual).toString('hex')).toBe(expectedHash);

    const schemaId = Buffer.from('codestudio.agent.fixture.v1', 'utf8');
    const preimage = Buffer.concat([
      Buffer.from('codestudio.agent.semantic-sha256.v1\0', 'utf8'),
      Buffer.from([0, 0, 0, schemaId.length]),
      schemaId,
      Buffer.from([0, 0, 0, 7]),
      Buffer.from([0, 0, 0, 0, 0, 0, 0, canonicalBytes.length]),
      canonicalBytes,
    ]);
    expect(preimage.toString('hex')).toBe(expectedPreimage);
  });

  it('rejects ambiguous schema coordinates', () => {
    expect(() => semanticSha256({
      schemaId: '',
      schemaVersion: 1,
      canonicalBytes: new Uint8Array(),
    })).toThrow(/schemaId/);
    expect(() => semanticSha256({
      schemaId: 'schema',
      schemaVersion: 0,
      canonicalBytes: new Uint8Array(),
    })).toThrow(/schemaVersion/);
  });
});
