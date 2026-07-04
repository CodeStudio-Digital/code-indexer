import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../../processing/types.js';
import { encodeGif, expandPingpong, MIN_FRAME_DELAY_MS } from '../gif.js';

const px = (bytes: number[], width: number, height: number): RgbaImage => ({
  rgba: new Uint8Array(bytes), width, height,
});

const RED2x1 = px([255, 0, 0, 255, 0, 255, 0, 255], 2, 1);
const BLUE2x1_ALPHA = px([0, 0, 255, 255, 0, 0, 0, 0], 2, 1);

describe('encodeGif', () => {
  it('encodes a 2-frame animated gif with sane header/trailer bytes', () => {
    const gif = encodeGif([RED2x1, BLUE2x1_ALPHA], [100, 50]);
    expect(gif.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    expect(gif[gif.length - 1]).toBe(0x3b); // GIF trailer
    // Logical screen descriptor: width 2, height 1 (little-endian u16s).
    expect(gif.readUInt16LE(6)).toBe(2);
    expect(gif.readUInt16LE(8)).toBe(1);
    // Two graphic-control extensions = two frames.
    let frames = 0;
    for (let i = 0; i < gif.length - 1; i++) {
      if (gif[i] === 0x21 && gif[i + 1] === 0xf9) frames++;
    }
    expect(frames).toBe(2);
  });

  it('honors per-frame delays in centiseconds with the 20ms floor', () => {
    const gif = encodeGif([RED2x1, RED2x1], [1000, 5]); // 5ms floors to 20ms
    const delays: number[] = [];
    for (let i = 0; i < gif.length - 5; i++) {
      // 0x21 0xF9 0x04 <packed> <delay u16le>
      if (gif[i] === 0x21 && gif[i + 1] === 0xf9 && gif[i + 2] === 0x04) {
        delays.push(gif.readUInt16LE(i + 4));
      }
    }
    expect(delays).toEqual([100, MIN_FRAME_DELAY_MS / 10]);
  });

  it('rejects empty input, duration/frame count mismatch and mixed sizes', () => {
    expect(() => encodeGif([], [])).toThrow(/no frames/);
    expect(() => encodeGif([RED2x1], [100, 100])).toThrow(/durations/);
    expect(() => encodeGif([RED2x1, px([0, 0, 0, 255], 1, 1)], [100, 100])).toThrow(/frame 1/);
  });
});

describe('expandPingpong', () => {
  it('appends the reversed interior (endpoints not doubled)', () => {
    expect(expandPingpong([1, 2, 3, 4])).toEqual([1, 2, 3, 4, 3, 2]);
  });
  it('leaves sequences under 3 items alone', () => {
    expect(expandPingpong([1, 2])).toEqual([1, 2]);
    expect(expandPingpong([1])).toEqual([1]);
  });
});
