/**
 * Coverage for extractApiSignature — best-effort symbol/signature parsing from
 * api_reference doc headings. Conservative: prose headings stay unannotated.
 */
import { describe, it, expect } from 'vitest';
import { extractApiSignature } from '../api-signature.js';

describe('extractApiSignature', () => {
  it('pulls symbol + signature from a qualified method heading', () => {
    expect(
      extractApiSignature('Physics > Rigidbody.AddForce(Vector3 force, ForceMode mode)'),
    ).toEqual({
      symbol: 'Rigidbody.AddForce',
      signature: 'Rigidbody.AddForce(Vector3 force, ForceMode mode)',
    });
  });

  it('handles a bare function signature with optional args', () => {
    expect(extractApiSignature('useEffect(setup, dependencies?)')).toEqual({
      symbol: 'useEffect',
      signature: 'useEffect(setup, dependencies?)',
    });
  });

  it('extracts a dotted member with no parens (property/const)', () => {
    expect(extractApiSignature('Rigidbody.velocity')).toEqual({
      symbol: 'Rigidbody.velocity',
      signature: null,
    });
  });

  it('captures multi-level C++ scope resolution', () => {
    expect(extractApiSignature('std::vector::push_back(const T& value)')).toEqual({
      symbol: 'std::vector::push_back',
      signature: 'std::vector::push_back(const T& value)',
    });
  });

  it('returns nulls for prose headings and null input', () => {
    expect(extractApiSignature('Getting Started')).toEqual({ symbol: null, signature: null });
    expect(extractApiSignature('Overview of physics')).toEqual({ symbol: null, signature: null });
    expect(extractApiSignature(null)).toEqual({ symbol: null, signature: null });
  });
});
