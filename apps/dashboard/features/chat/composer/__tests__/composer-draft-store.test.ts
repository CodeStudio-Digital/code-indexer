import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDraft,
  getDraft,
  hydrateFromStorageOnce,
  setDraft,
  subscribeDraft,
} from '../composer-draft-store.js';
import type { AgentAttachment } from '../../../../hooks/agent-stream/types.js';

const img = (name: string): AgentAttachment => ({ name, mediaType: 'image/png', base64: 'AAAA' });

// Each test uses its own key — the store is a module-level singleton.
let nextId = 1;
const key = () => `coder:${nextId++}`;

// The vitest env is `node`, so there's no real localStorage. Stub a minimal
// in-memory one so the text-persistence path is actually exercised.
function installLocalStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  });
  return backing;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getDraft / setDraft', () => {
  it('returns a stable EMPTY draft for an untouched key', () => {
    const a = getDraft(key());
    const b = getDraft(key());
    expect(a).toEqual({ text: '', attachments: [] });
    expect(a).toBe(b); // same reference — no churn
  });

  it('round-trips text and attachments', () => {
    const k = key();
    const atts = [img('a.png')];
    setDraft(k, { text: 'hello', attachments: atts });
    const d = getDraft(k);
    expect(d.text).toBe('hello');
    expect(d.attachments).toBe(atts);
  });

  it('setDraft with an empty draft deletes the entry', () => {
    const k = key();
    setDraft(k, { text: 'x', attachments: [] });
    setDraft(k, { text: '', attachments: [] });
    expect(getDraft(k)).toEqual({ text: '', attachments: [] });
  });

  it('identity short-circuit: an unchanged setDraft does not notify subscribers', () => {
    const k = key();
    const atts = [img('a.png')];
    setDraft(k, { text: 't', attachments: atts });
    const spy = vi.fn();
    subscribeDraft(k, spy);
    // Same field values (different wrapper object) → no notify.
    setDraft(k, { text: 't', attachments: atts });
    expect(spy).not.toHaveBeenCalled();
    // A real change → notify.
    setDraft(k, { text: 't2', attachments: atts });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('clearDraft', () => {
  it('removes the entry and notifies exactly once', () => {
    const k = key();
    setDraft(k, { text: 'draft', attachments: [img('a.png')] });
    const spy = vi.fn();
    subscribeDraft(k, spy);
    clearDraft(k);
    expect(getDraft(k)).toEqual({ text: '', attachments: [] });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('subscribeDraft', () => {
  it('unsubscribe stops further notifications', () => {
    const k = key();
    const spy = vi.fn();
    const off = subscribeDraft(k, spy);
    setDraft(k, { text: 'a', attachments: [] });
    expect(spy).toHaveBeenCalledTimes(1);
    off();
    setDraft(k, { text: 'b', attachments: [] });
    expect(spy).toHaveBeenCalledTimes(1); // no further calls
  });
});

describe('localStorage (text only)', () => {
  let backing: Map<string, string>;
  beforeEach(() => {
    backing = installLocalStorage();
  });

  it('persists text under the composerDraft: prefix and removes it when empty', () => {
    const k = key();
    setDraft(k, { text: 'persisted', attachments: [] });
    expect(backing.get(`composerDraft:${k}`)).toBe('persisted');
    setDraft(k, { text: '', attachments: [] });
    expect(backing.has(`composerDraft:${k}`)).toBe(false);
  });

  it('never writes attachments to disk', () => {
    const k = key();
    setDraft(k, { text: '', attachments: [img('big.png')] });
    // text is empty → no localStorage entry even though an attachment exists
    expect(backing.has(`composerDraft:${k}`)).toBe(false);
  });

  it('hydrateFromStorageOnce seeds in-memory text from disk, once', () => {
    const k = key();
    backing.set(`composerDraft:${k}`, 'from-disk');
    hydrateFromStorageOnce(k);
    expect(getDraft(k).text).toBe('from-disk');
    // In-memory wins on a second hydrate of a different (cleared) state.
    clearDraft(k);
    hydrateFromStorageOnce(k); // already hydrated → no-op
    expect(getDraft(k).text).toBe('');
  });

  it('clearDraft removes the localStorage entry too', () => {
    const k = key();
    setDraft(k, { text: 'x', attachments: [] });
    clearDraft(k);
    expect(backing.has(`composerDraft:${k}`)).toBe(false);
  });
});
