import { describe, expect, it } from 'vitest';
import {
  packProtocolVersion,
  unpackProtocolVersion,
} from '../version.js';

describe('frame protocol version packing', () => {
  it('matches the normative major/minor layout', () => {
    expect(packProtocolVersion({ major: 1, minor: 1 })).toBe(65_537);
    expect(unpackProtocolVersion(65_537)).toEqual({ major: 1, minor: 1 });
    expect(
      unpackProtocolVersion(
        packProtocolVersion({ major: 0xffff, minor: 0xffff }),
      ),
    ).toEqual({ major: 0xffff, minor: 0xffff });
  });

  it('rejects values outside the wire widths', () => {
    expect(() => packProtocolVersion({ major: -1, minor: 0 })).toThrow(
      RangeError,
    );
    expect(() => packProtocolVersion({ major: 1, minor: 0x1_0000 })).toThrow(
      RangeError,
    );
    expect(() => unpackProtocolVersion(0x1_0000_0000)).toThrow(RangeError);
  });
});
