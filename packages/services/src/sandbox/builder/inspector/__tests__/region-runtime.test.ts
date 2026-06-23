import { describe, expect, it } from 'vitest';
import { REGION_HELPERS_SOURCE } from '../region-runtime.js';

/**
 * The region helpers are a string fragment that runs inside the preview app.
 * We eval it in a fake DOM (jsdom has no real layout) to exercise the pure
 * geometry: contained-filter → outermost collapse → dedup → cap. Marquee
 * drawing isn't tested here (it needs a real document); only mcpCollectRegion
 * and mcpRegionFromPoints, which are the parts with real logic.
 */
interface FakeRect { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface FakeEl {
  nodeType: number;
  tagName: string;
  parentElement: FakeEl | null;
  getBoundingClientRect(): FakeRect;
  hasAttribute(a: string): boolean;
  getAttribute(a: string): string | null;
}

function rect(left: number, top: number, w: number, h: number): FakeRect {
  return { left, top, right: left + w, bottom: top + h, width: w, height: h };
}
function makeEl(r: FakeRect, attrs: Record<string, string> = {}, parent: FakeEl | null = null): FakeEl {
  return {
    nodeType: 1,
    tagName: (attrs.tag ?? 'div').toUpperCase(),
    parentElement: parent,
    getBoundingClientRect: () => r,
    hasAttribute: (a) => a in attrs,
    getAttribute: (a) => attrs[a] ?? null,
  };
}

type Region = { x: number; y: number; width: number; height: number };
interface RegionApi {
  mcpCollectRegion(
    region: Region,
    opts: { all: () => FakeEl[]; describe: (el: FakeEl) => unknown },
  ): Array<{ loc: string }>;
  mcpRegionFromPoints(x0: number, y0: number, x1: number, y1: number): Region;
}

function loadApi(body: FakeEl): RegionApi {
  const factory = new Function(
    'window',
    'document',
    `${REGION_HELPERS_SOURCE}\nreturn { mcpCollectRegion: mcpCollectRegion, mcpRegionFromPoints: mcpRegionFromPoints };`,
  );
  return factory({ devicePixelRatio: 1 }, { body }) as RegionApi;
}

const describeLoc = (el: FakeEl) => ({ loc: el.getAttribute('data-mcp-loc') || '', tag: 'div', text: '' });

describe('mcpRegionFromPoints', () => {
  it('normalizes drag direction to a positive rect', () => {
    const body = makeEl(rect(0, 0, 1000, 1000));
    const { mcpRegionFromPoints } = loadApi(body);
    expect(mcpRegionFromPoints(80, 90, 10, 20)).toEqual({ x: 10, y: 20, width: 70, height: 70 });
  });
});

describe('mcpCollectRegion', () => {
  it('keeps outermost fully-contained elements and drops the spilling ancestor + inner guts', () => {
    const body = makeEl(rect(0, 0, 1000, 1000));
    const { mcpCollectRegion } = loadApi(body);
    // Section spills outside the 100x100 box (not fully contained → excluded).
    const section = makeEl(rect(0, 0, 200, 200), { 'data-mcp-loc': 'S' }, body);
    const card1 = makeEl(rect(10, 10, 30, 80), { 'data-mcp-loc': 'C1' }, section);
    const card2 = makeEl(rect(55, 10, 30, 80), { 'data-mcp-loc': 'C2' }, section);
    const inner = makeEl(rect(12, 12, 20, 20), { 'data-mcp-loc': 'I1' }, card1); // nested in card1
    const all = [section, card1, card2, inner];
    const out = mcpCollectRegion({ x: 0, y: 0, width: 100, height: 100 }, { all: () => all, describe: describeLoc });
    expect(out.map((d) => d.loc)).toEqual(['C1', 'C2']);
  });

  it('dedups by loc', () => {
    const body = makeEl(rect(0, 0, 1000, 1000));
    const { mcpCollectRegion } = loadApi(body);
    const a = makeEl(rect(10, 10, 20, 20), { 'data-mcp-loc': 'DUP' }, body);
    const b = makeEl(rect(40, 10, 20, 20), { 'data-mcp-loc': 'DUP' }, body);
    const out = mcpCollectRegion({ x: 0, y: 0, width: 100, height: 100 }, { all: () => [a, b], describe: describeLoc });
    expect(out.map((d) => d.loc)).toEqual(['DUP']);
  });

  it('caps the result at 12', () => {
    const body = makeEl(rect(0, 0, 1000, 1000));
    const { mcpCollectRegion } = loadApi(body);
    const els = Array.from({ length: 20 }, (_, i) => makeEl(rect(2 + i, 2, 4, 4), { 'data-mcp-loc': 'L' + i }, body));
    const out = mcpCollectRegion({ x: 0, y: 0, width: 500, height: 500 }, { all: () => els, describe: describeLoc });
    expect(out.length).toBe(12);
  });

  it('falls back to center-inside when nothing is fully contained (partial drag)', () => {
    const body = makeEl(rect(0, 0, 1000, 1000));
    const { mcpCollectRegion } = loadApi(body);
    // Element straddles the box edge: not fully contained, but its center is inside.
    const big = makeEl(rect(40, 40, 80, 80), { 'data-mcp-loc': 'BIG' }, body); // center (80,80) inside 100x100
    const out = mcpCollectRegion({ x: 0, y: 0, width: 100, height: 100 }, { all: () => [big], describe: describeLoc });
    expect(out.map((d) => d.loc)).toEqual(['BIG']);
  });

  it('skips elements whose describe() returns null (e.g. the toolbar host)', () => {
    const body = makeEl(rect(0, 0, 1000, 1000));
    const { mcpCollectRegion } = loadApi(body);
    const toolbar = makeEl(rect(10, 10, 30, 30), { 'data-mcp-loc': 'TB' }, body);
    const real = makeEl(rect(50, 10, 30, 30), { 'data-mcp-loc': 'R' }, body);
    const out = mcpCollectRegion(
      { x: 0, y: 0, width: 100, height: 100 },
      { all: () => [toolbar, real], describe: (el) => (el === toolbar ? null : describeLoc(el)) },
    );
    expect(out.map((d) => d.loc)).toEqual(['R']);
  });

  it('skips marquee/overlay and zero-size elements', () => {
    const body = makeEl(rect(0, 0, 1000, 1000));
    const { mcpCollectRegion } = loadApi(body);
    const marquee = makeEl(rect(0, 0, 50, 50), { 'data-mcp-marquee': '', 'data-mcp-loc': 'M' }, body);
    const tiny = makeEl(rect(5, 5, 2, 2), { 'data-mcp-loc': 'T' }, body); // < 4px → skipped
    const real = makeEl(rect(10, 10, 30, 30), { 'data-mcp-loc': 'R' }, body);
    const out = mcpCollectRegion({ x: 0, y: 0, width: 100, height: 100 }, { all: () => [marquee, tiny, real], describe: describeLoc });
    expect(out.map((d) => d.loc)).toEqual(['R']);
  });
});
