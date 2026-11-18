/**
 * Unit tests for the conflict-region parser — the pure foundation under
 * both the inline resolver and the 3-pane merge editor. (attachConflictUI
 * needs a live Monaco editor and is covered by manual E2E.)
 */
import type * as Monaco from 'monaco-editor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachConflictUI,
  parseConflictRegions,
  hasConflictMarkers,
  computeResolutionText,
  type ConflictRegion,
} from '../conflict-markers.js';

const TWO_WAY = [
  'before',
  '<<<<<<< HEAD',
  'ours line 1',
  'ours line 2',
  '=======',
  'theirs line 1',
  '>>>>>>> feature',
  'after',
].join('\n');

const DIFF3 = [
  '<<<<<<< ours',
  'our change',
  '||||||| base',
  'common ancestor',
  '=======',
  'their change',
  '>>>>>>> theirs',
].join('\n');

describe('parseConflictRegions', () => {
  it('parses a standard two-way conflict with correct 1-based lines + text', () => {
    const [r, ...rest] = parseConflictRegions(TWO_WAY);
    expect(rest).toHaveLength(0);
    expect(r.startLine).toBe(2); // <<<<<<< is line 2 (1-based)
    expect(r.sepLine).toBe(5);
    expect(r.endLine).toBe(7);
    expect(r.baseLine).toBeUndefined();
    expect(r.currentText).toBe('ours line 1\nours line 2');
    expect(r.incomingText).toBe('theirs line 1');
  });

  it('handles diff3 (|||||||) by excluding the base block from current', () => {
    const [r] = parseConflictRegions(DIFF3);
    expect(r.baseLine).toBe(3);
    expect(r.currentText).toBe('our change'); // stops at the base marker
    expect(r.incomingText).toBe('their change');
  });

  it('finds multiple independent regions', () => {
    const text = `${TWO_WAY}\nmiddle\n${TWO_WAY}`;
    expect(parseConflictRegions(text)).toHaveLength(2);
  });

  it('returns nothing for clean text and reports no markers', () => {
    expect(parseConflictRegions('just\nnormal\ncode\n')).toHaveLength(0);
    expect(hasConflictMarkers('just\nnormal\ncode\n')).toBe(false);
    expect(hasConflictMarkers(TWO_WAY)).toBe(true);
  });

  it('ignores an unterminated marker (no separator/end)', () => {
    expect(parseConflictRegions('<<<<<<< HEAD\norphan\nno end here')).toHaveLength(0);
  });

  it('handles a large run of incomplete markers before a valid conflict', () => {
    const incomplete = '<<<<<<< interrupted\n'.repeat(10_000) + '>>>>>>> closed without a separator\n';
    const [region, ...rest] = parseConflictRegions(incomplete + TWO_WAY);
    expect(rest).toHaveLength(0);
    expect(region).toMatchObject({ startLine: 10_003, currentText: 'ours line 1\nours line 2' });
  });
});

describe('computeResolutionText', () => {
  const mk = (currentText: string, incomingText: string): ConflictRegion => ({
    startLine: 1, sepLine: 3, endLine: 5, currentText, incomingText,
  });

  it('returns the chosen side verbatim', () => {
    expect(computeResolutionText(mk('ours', 'theirs'), 'current')).toBe('ours');
    expect(computeResolutionText(mk('ours', 'theirs'), 'incoming')).toBe('theirs');
    expect(computeResolutionText(mk('ours', 'theirs'), 'both')).toBe('ours\ntheirs');
  });

  it('does not inject a blank line when one side is empty in "both"', () => {
    expect(computeResolutionText(mk('', 'theirs'), 'both')).toBe('theirs');
    expect(computeResolutionText(mk('ours', ''), 'both')).toBe('ours');
    expect(computeResolutionText(mk('', ''), 'both')).toBe('');
  });

  it('an empty chosen side yields empty text (caller deletes the block)', () => {
    expect(computeResolutionText(mk('', 'theirs'), 'current')).toBe('');
  });
});

describe('conflict decorations and CodeLens', () => {
  afterEach(() => vi.useRealTimers());

  it('coalesces edits, shares the parsed version, and rejects stale actions', () => {
    vi.useFakeTimers();
    let version = 1;
    let text = TWO_WAY;
    let listener: (() => void) | undefined;
    let provider: Monaco.languages.CodeLensProvider | undefined;
    type Command = (accessor: unknown, ...args: unknown[]) => void;
    let apply: Command | undefined;
    const uri = { toString: () => 'file:///example.ts' };
    const model = {
      uri,
      isDisposed: () => false,
      getVersionId: () => version,
      getValue: vi.fn(() => text),
      getLineCount: () => text.split('\n').length,
      getLineMaxColumn: (line: number) => text.split('\n')[line - 1].length + 1,
      onDidChangeContent: (fn: () => void) => {
        listener = fn;
        return { dispose: () => { listener = undefined; } };
      },
      pushEditOperations: vi.fn(),
    };
    const collection = { set: vi.fn(), clear: vi.fn() };
    const editor = { getModel: () => model, createDecorationsCollection: () => collection };
    const monaco = {
      editor: { registerCommand: (_id: string, fn: Command) => { apply = fn; }, getModel: () => model },
      languages: {
        registerCodeLensProvider: (_selector: string, next: Monaco.languages.CodeLensProvider) => {
          provider = next;
          return { dispose: vi.fn() };
        },
      },
      Uri: { parse: () => uri },
      Range: class {},
      Emitter: class { event = vi.fn(); fire = vi.fn(); dispose = vi.fn(); },
    };
    const handle = attachConflictUI(
      editor as unknown as Monaco.editor.IStandaloneCodeEditor,
      monaco as unknown as typeof Monaco,
      { current: 'Current', incoming: 'Incoming', both: 'Both' },
    );
    const lenses = () => (provider!.provideCodeLenses(
      model as unknown as Monaco.editor.ITextModel,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.CodeLensList).lenses;

    expect(lenses()).toHaveLength(0);
    vi.advanceTimersByTime(100);
    const staleArguments = lenses()[0].command!.arguments!;
    expect(model.getValue).toHaveBeenCalledTimes(1);
    expect(collection.set).toHaveBeenCalledTimes(1);

    const edit = () => { version++; listener?.(); };
    text = `new line\n${TWO_WAY}`;
    edit();
    vi.advanceTimersByTime(50);
    edit();
    expect(lenses()).toHaveLength(0);
    apply?.(null, ...staleArguments);
    expect(model.pushEditOperations).not.toHaveBeenCalled();
    expect(model.getValue).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(lenses()).toHaveLength(3);
    expect(model.getValue).toHaveBeenCalledTimes(2);
    apply?.(null, ...lenses()[0].command!.arguments!);
    expect(model.pushEditOperations).toHaveBeenCalledWith(
      [], [expect.objectContaining({ range: expect.objectContaining({ startLineNumber: 3 }) })], expect.any(Function),
    );

    edit();
    handle.dispose();
    vi.runAllTimers();
    expect(model.getValue).toHaveBeenCalledTimes(2);
  });
});
