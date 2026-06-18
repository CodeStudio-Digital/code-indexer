/**
 * Magic-byte sniffer — accepts only real PNG/JPEG/GIF/WEBP; rejects SVG, HTML,
 * a renamed-extension polyglot, empty, and random bytes (the upload allowlist).
 */
import { describe, it, expect } from 'vitest';
import { createContentSniffer } from '../infra/content-sniffer.js';

const sniffer = createContentSniffer();
const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new TextEncoder().encode(s);

describe('content sniffer (images-only allowlist)', () => {
  it('accepts a PNG header', () => {
    expect(sniffer.sniff(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))?.contentType).toBe('image/png');
  });
  it('accepts a JPEG header', () => {
    expect(sniffer.sniff(bytes(0xff, 0xd8, 0xff, 0xe0))?.contentType).toBe('image/jpeg');
  });
  it('accepts a GIF header', () => {
    expect(sniffer.sniff(ascii('GIF89a'))?.contentType).toBe('image/gif');
  });
  it('accepts a WEBP (RIFF…WEBP) header', () => {
    const head = new Uint8Array(12);
    head.set(ascii('RIFF'), 0);
    head.set(ascii('WEBP'), 8);
    expect(sniffer.sniff(head)?.contentType).toBe('image/webp');
  });

  it('rejects SVG (text/xml — script vector)', () => {
    expect(sniffer.sniff(ascii('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
  });
  it('rejects HTML', () => {
    expect(sniffer.sniff(ascii('<!DOCTYPE html><html>'))).toBeNull();
  });
  it('rejects a renamed polyglot (HTML bytes regardless of declared type)', () => {
    expect(sniffer.sniff(ascii('<html><script>alert(1)</script>'))).toBeNull();
  });
  it('rejects empty and random bytes', () => {
    expect(sniffer.sniff(bytes())).toBeNull();
    expect(sniffer.sniff(bytes(0x00, 0x01, 0x02, 0x03))).toBeNull();
  });
  it('all image kinds report kind=image', () => {
    expect(sniffer.sniff(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.kind).toBe('image');
  });
});
