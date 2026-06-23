/**
 * Global filter + observer integration tests.
 *
 * Verifies:
 *   - setGlobalToolSelectionFilter installs the filter
 *   - getGlobalToolSelectionFilter retrieves the installed filter
 *   - setGlobalToolSelectionFilter(undefined) clears the installation
 *   - setGlobalToolSelectionOutcomeObserver pattern is symmetric
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getGlobalToolSelectionFilter,
  setGlobalToolSelectionFilter,
  setGlobalToolSelectionOutcomeObserver,
  getGlobalToolSelectionOutcomeObserver,
  type ToolSelectionOutcomeObserver,
} from '../global-filter.js';
import type { ThinTool } from '../runtime-helper-thin.js';

describe('global filter + observer', () => {
  afterEach(() => {
    setGlobalToolSelectionFilter(undefined);
    setGlobalToolSelectionOutcomeObserver(undefined);
  });

  it('starts uninstalled', () => {
    setGlobalToolSelectionFilter(undefined);
    setGlobalToolSelectionOutcomeObserver(undefined);
    expect(getGlobalToolSelectionFilter()).toBeUndefined();
    expect(getGlobalToolSelectionOutcomeObserver()).toBeUndefined();
  });

  it('round-trips a filter through setter + getter', async () => {
    const filter = async (tools: ThinTool[]) => tools.slice(0, 2);
    setGlobalToolSelectionFilter(filter);
    const installed = getGlobalToolSelectionFilter();
    expect(installed).toBe(filter);
    const out = await installed!(
      [
        { name: 'a', description: 'a', parameters: { type: 'object', properties: {} } },
        { name: 'b', description: 'b', parameters: { type: 'object', properties: {} } },
        { name: 'c', description: 'c', parameters: { type: 'object', properties: {} } },
      ],
      { taskText: 'x', recentToolCalls: [] },
    );
    expect(out.map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('setter with undefined uninstalls a previously-installed filter', () => {
    setGlobalToolSelectionFilter(async (tools) => tools);
    expect(getGlobalToolSelectionFilter()).toBeDefined();
    setGlobalToolSelectionFilter(undefined);
    expect(getGlobalToolSelectionFilter()).toBeUndefined();
  });

  it('observer round-trips through setter + getter', () => {
    const calls: Array<{ taskText: string; toolsCalled: ReadonlyArray<string> }> = [];
    const observer: ToolSelectionOutcomeObserver = (taskText, toolsCalled) => {
      calls.push({ taskText, toolsCalled });
    };
    setGlobalToolSelectionOutcomeObserver(observer);
    const installed = getGlobalToolSelectionOutcomeObserver();
    expect(installed).toBe(observer);
    installed!('refactor login', ['Read', 'Edit']);
    expect(calls).toHaveLength(1);
    expect(calls[0].taskText).toBe('refactor login');
    expect(calls[0].toolsCalled).toEqual(['Read', 'Edit']);
  });

  it('filter + observer are independent (one stays installed when the other is cleared)', () => {
    const filter = async (tools: ThinTool[]) => tools;
    const observer: ToolSelectionOutcomeObserver = () => {};
    setGlobalToolSelectionFilter(filter);
    setGlobalToolSelectionOutcomeObserver(observer);
    setGlobalToolSelectionFilter(undefined);
    expect(getGlobalToolSelectionFilter()).toBeUndefined();
    expect(getGlobalToolSelectionOutcomeObserver()).toBe(observer);
  });
});
