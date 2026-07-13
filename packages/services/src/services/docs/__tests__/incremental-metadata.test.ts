import { describe, expect, it } from 'vitest';
import { deterministicMetadata, extractApiMetadata, stableChunkKey } from '../incremental-metadata.js';

describe('incremental documentation metadata', () => {
  it('keeps stable keys deterministic and item-scoped', () => {
    const input = { itemKey: 'Rigidbody.AddForce.html', pageKey: 'page-1', headingPath: 'Rigidbody.AddForce', occurrence: 0 };
    expect(stableChunkKey(input)).toBe(stableChunkKey(input));
    expect(stableChunkKey({ ...input, itemKey: 'Collider.AddForce.html' })).not.toBe(stableChunkKey(input));
    expect(stableChunkKey({ ...input, occurrence: 1 })).not.toBe(stableChunkKey(input));
  });

  it('extracts a Unity-style declaration without an LLM', () => {
    const content = `Declaration\n\npublic void AddForce(Vector3 force, ForceMode mode);\n\nAdds a force to the Rigidbody.`;
    const api = extractApiMetadata('Rigidbody > AddForce', content);
    expect(api.symbol).toContain('AddForce');
    expect(api.signature).toContain('(Vector3 force, ForceMode mode)');
    const meta = deterministicMetadata('Rigidbody > AddForce', `${content}\n\n${'This API changes the velocity of a rigid body in a deterministic physics simulation. '.repeat(2)}`, api);
    expect(meta.concepts).toContain('AddForce');
    expect(meta.concepts.length).toBeGreaterThanOrEqual(3);
  });
});
