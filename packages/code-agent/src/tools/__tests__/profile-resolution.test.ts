import { describe, it, expect } from 'vitest';
import {
  parseToolsetState,
  resolveSessionProfile,
  widenProfile,
} from '@mcp/code-agent/tools/profile-resolution.js';

/**
 * Sticky profile (mig 142) — the resolved profile must be byte-stable across
 * runs of the same session regardless of WHICH tail of the history happens to
 * be loaded. Session 991: `inferProfileFromHistory` over the loaded tail
 * flipped navigate(~60 tools) ↔ full(118) between rounds, busting the entire
 * provider prompt-cache prefix on every round's turn 1.
 */

// Tier ground truth (tiers.ts): mcp__read_file=bootstrap, edit_file=navigate,
// git_commit=admin. Native `read_file` is NOT bootstrap — P4 (jul/2026)
// demoted it to navigate as the disk fallback behind mcp__read_file, so it
// cannot stand in for a bootstrap-only tail.
const TAIL_BOOTSTRAP_ONLY = ['mcp__read_file', 'mcp__read_file'];
const TAIL_WITH_NAVIGATE = ['mcp__read_file', 'edit_file'];
const TAIL_WITH_ADMIN = ['mcp__read_file', 'git_commit'];

describe('widenProfile', () => {
  it('returns the higher-ranked profile', () => {
    expect(widenProfile('bootstrap', 'navigate')).toBe('navigate');
    expect(widenProfile('full', 'navigate')).toBe('full');
    expect(widenProfile('navigate', 'navigate')).toBe('navigate');
  });
});

describe('parseToolsetState', () => {
  it('returns null for never-stamped sessions', () => {
    expect(parseToolsetState(null, null)).toBeNull();
    expect(parseToolsetState(undefined, undefined)).toBeNull();
  });

  it('parses profile + state json', () => {
    const s = parseToolsetState('full', '{"v":1,"extraTiers":["preview"],"pins":["mcp__search"],"visibleCap":48}');
    expect(s).toEqual({ profile: 'full', extraTiers: ['preview'], pins: ['mcp__search'], visibleCap: 48 });
  });

  it('degrades corrupted json to an empty state instead of failing', () => {
    const s = parseToolsetState('navigate', '{not json');
    expect(s).toEqual({ profile: 'navigate', extraTiers: [], pins: [], visibleCap: null });
  });

  it('ignores an invalid profile column value', () => {
    const s = parseToolsetState('yolo', '{"pins":["a"]}');
    expect(s?.profile).toBeNull();
    expect(s?.pins).toEqual(['a']);
  });
});

describe('resolveSessionProfile — sticky ON', () => {
  const base = {
    hasHistory: true,
    stickyEnabled: true,
    persisted: { profile: 'full' as const, extraTiers: [], pins: [], visibleCap: null },
  };

  it('persisted profile wins over tail inference — same profile for ANY loaded tail', () => {
    const a = resolveSessionProfile({ ...base, historyToolNames: TAIL_BOOTSTRAP_ONLY });
    const b = resolveSessionProfile({ ...base, historyToolNames: TAIL_WITH_NAVIGATE });
    expect(a.profile).toBe('full');
    expect(b.profile).toBe('full');
    expect(a.persistAs).toBeNull(); // nothing to write — already widest
    expect(a.source).toBe('persisted');
  });

  it('NEVER narrows: bootstrap-only tail does not shrink a navigate session', () => {
    const r = resolveSessionProfile({
      ...base,
      persisted: { profile: 'navigate', extraTiers: [], pins: [], visibleCap: null },
      historyToolNames: TAIL_BOOTSTRAP_ONLY,
    });
    expect(r.profile).toBe('navigate');
    expect(r.persistAs).toBeNull();
  });

  it('widens when the loaded tail demonstrably used a higher tier', () => {
    const r = resolveSessionProfile({
      ...base,
      persisted: { profile: 'navigate', extraTiers: [], pins: [], visibleCap: null },
      historyToolNames: TAIL_WITH_ADMIN,
    });
    expect(r.profile).toBe('full');
    expect(r.persistAs).toBe('full');
    expect(r.source).toBe('persisted-widened');
  });

  it('legacy resumed session (no stamp): adopts the inference ONCE and persists it', () => {
    const r = resolveSessionProfile({
      hasHistory: true,
      stickyEnabled: true,
      persisted: null,
      historyToolNames: TAIL_WITH_NAVIGATE,
    });
    expect(r.profile).toBe('navigate');
    expect(r.persistAs).toBe('navigate');
    expect(r.source).toBe('history-adopted');
  });

  it('fresh session: preflight seed or bootstrap default, stamped at creation', () => {
    const seeded = resolveSessionProfile({
      hasHistory: false, stickyEnabled: true, persisted: null,
      historyToolNames: [], preflightProfile: 'navigate',
    });
    expect(seeded).toMatchObject({ profile: 'navigate', persistAs: 'navigate', source: 'preflight' });

    const plain = resolveSessionProfile({
      hasHistory: false, stickyEnabled: true, persisted: null, historyToolNames: [],
    });
    expect(plain).toMatchObject({ profile: 'bootstrap', persistAs: 'bootstrap', source: 'default' });
  });

  it('explicit wins for the run; narrower explicit does not clobber the stamp', () => {
    const r = resolveSessionProfile({
      ...base,
      historyToolNames: TAIL_BOOTSTRAP_ONLY,
      explicitProfile: 'bootstrap',
    });
    expect(r.profile).toBe('bootstrap'); // diagnostic run honors the override
    expect(r.persistAs).toBeNull();      // ...but the stored 'full' survives
  });

  it('explicit wider than the stamp persists the widen', () => {
    const r = resolveSessionProfile({
      hasHistory: true, stickyEnabled: true,
      persisted: { profile: 'bootstrap', extraTiers: [], pins: [], visibleCap: null },
      historyToolNames: TAIL_BOOTSTRAP_ONLY,
      explicitProfile: 'full',
    });
    expect(r.profile).toBe('full');
    expect(r.persistAs).toBe('full');
  });

  it("explicit 'auto' resolves preflight → message heuristic", () => {
    const viaPreflight = resolveSessionProfile({
      hasHistory: false, stickyEnabled: true, persisted: null, historyToolNames: [],
      explicitProfile: 'auto', preflightProfile: 'navigate',
    });
    expect(viaPreflight.profile).toBe('navigate');

    const viaMessage = resolveSessionProfile({
      hasHistory: false, stickyEnabled: true, persisted: null, historyToolNames: [],
      explicitProfile: 'auto', userMessage: 'refatore o módulo de auth',
    });
    expect(viaMessage.profile).toBe('navigate');
  });
});

describe('resolveSessionProfile — sticky OFF reproduces legacy behavior', () => {
  it('resumed: per-run inference (the old flip), nothing persisted', () => {
    const a = resolveSessionProfile({
      hasHistory: true, stickyEnabled: false,
      persisted: { profile: 'full', extraTiers: [], pins: [], visibleCap: null },
      historyToolNames: TAIL_BOOTSTRAP_ONLY,
    });
    expect(a.profile).toBe('bootstrap'); // legacy: tail rules, stamp ignored
    expect(a.persistAs).toBeNull();
  });

  it('fresh: preflight seed or bootstrap, nothing persisted', () => {
    const r = resolveSessionProfile({
      hasHistory: false, stickyEnabled: false, persisted: null,
      historyToolNames: [], preflightProfile: 'navigate',
    });
    expect(r).toMatchObject({ profile: 'navigate', persistAs: null });
  });
});
