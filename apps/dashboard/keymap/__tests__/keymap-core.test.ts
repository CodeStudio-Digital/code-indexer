import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_CATALOG, registerCommandHandlers } from '../commands.js';
import { contextsOverlap, effectiveBindings, migrateKeymapState, useKeymapStore } from '../keymap-store.js';
import { eventToChord, eventToMouseChord, installKeymapDispatcher } from '../dispatcher.js';
import { installShortcutRecorder } from '../recorder.js';
import { bindingToMonaco, buildManagedMonacoRules } from '../../features/workspace/editor/monaco-keymap.js';

const fakeMonaco = {
  KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512, chord: (a: number, b: number) => a * 10000 + b },
  KeyCode: {
    Slash: 85, ABNT_C1: 115, NumpadDivide: 113, KeyK: 40, KeyS: 48, KeyL: 42,
    KeyA: 30, KeyD: 33, KeyY: 54, KeyW: 52, KeyJ: 39, KeyP: 45, KeyQ: 46,
    KeyB: 31, KeyU: 50, KeyO: 44, KeyF: 35, Digit0: 21, US_MINUS: 88,
    NumpadAdd: 104, US_OPEN_SQUARE_BRACKET: 90, US_CLOSE_SQUARE_BRACKET: 91,
    UpArrow: 16, DownArrow: 18, LeftArrow: 15, RightArrow: 17, Enter: 3,
    F2: 60, F6: 64, F7: 65, F8: 66, F12: 70, Space: 10,
  },
  editor: { addKeybindingRules: () => ({ dispose() {} }) },
} as never;

describe('professional keymap core', () => {
  beforeEach(() => useKeymapStore.setState({ preset: 'intellij', overrides: {} }));
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('has one unique static spec for every managed built-in action', () => {
    const ids = COMMAND_CATALOG.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('editor.format');
    expect(ids).toContain('editor.toggleLineComment');
    expect(ids).toContain('workbench.commandPalette');
  });

  it('migrates legacy string/null overrides to binding arrays', () => {
    expect(migrateKeymapState({ preset: 'vscode', overrides: { a: 'Ctrl+A', b: null, c: ['Alt+C'] } })).toEqual({
      preset: 'vscode', overrides: { a: ['Ctrl+A'], b: [], c: ['Alt+C'] },
    });
  });

  it('supports multiple bindings and removes only the replaced conflict', () => {
    const store = useKeymapStore.getState();
    store.setBindings('editor.format', ['Ctrl+Alt+L', 'Ctrl+Shift+F']);
    store.setBindings('editor.toggleLineComment', ['Ctrl+/', 'Ctrl+Shift+F']);
    useKeymapStore.getState().replaceConflict('editor.format', 'Ctrl+Shift+F', ['editor.toggleLineComment']);
    const state = useKeymapStore.getState();
    const format = COMMAND_CATALOG.find((command) => command.id === 'editor.format')!;
    const comment = COMMAND_CATALOG.find((command) => command.id === 'editor.toggleLineComment')!;
    expect(effectiveBindings(format, state.preset, state.overrides)).toEqual(['Ctrl+Alt+L', 'Ctrl+Shift+F']);
    expect(effectiveBindings(comment, state.preset, state.overrides)).toEqual(['Ctrl+/']);
  });

  it('recognizes mutually exclusive Monaco contexts', () => {
    expect(contextsOverlap('editorTextFocus && editorHasSelection', 'editorTextFocus && !editorHasSelection')).toBe(false);
    expect(contextsOverlap('editorTextFocus', 'editorTextFocus && editorHasSelection')).toBe(true);
    expect(contextsOverlap('sqlEditorFocus', 'editorTextFocus && !sqlEditorFocus')).toBe(false);
  });

  it('normalizes ABNT2 slash and numpad divide to the same binding', () => {
    const event = (code: string) => ({ code, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }) as KeyboardEvent;
    expect(eventToChord(event('Slash'))).toBe('Ctrl+/');
    expect(eventToChord(event('IntlRo'))).toBe('Ctrl+/');
    expect(eventToChord(event('NumpadDivide'))).toBe('Ctrl+/');
  });

  it('maps middle, back, forward, and additional mouse buttons while excluding left/right', () => {
    const event = (button: number, altKey = false) => ({
      button, ctrlKey: false, metaKey: false, altKey, shiftKey: false,
    }) as MouseEvent;
    expect(eventToMouseChord(event(0))).toBeNull();
    expect(eventToMouseChord(event(2))).toBeNull();
    expect(eventToMouseChord(event(1))).toBe('Mouse3');
    expect(eventToMouseChord(event(3))).toBe('Mouse4');
    expect(eventToMouseChord(event(4))).toBe('Mouse5');
    expect(eventToMouseChord(event(5))).toBe('Mouse6');
    expect(eventToMouseChord(event(3, true))).toBe('Alt+Mouse4');
  });

  it('generates Monaco bindings for all slash keys and applies overrides live', () => {
    expect(bindingToMonaco(fakeMonaco, 'Ctrl+Shift+/')).toHaveLength(3);
    useKeymapStore.getState().setBindings('editor.toggleLineComment', ['Ctrl+Shift+/']);
    const commentRules = buildManagedMonacoRules(fakeMonaco).filter((rule) => rule.command === 'editor.action.commentLine');
    expect(commentRules).toHaveLength(3);
  });

  it('defers an exact action that is also a chord prefix, then resolves either path', () => {
    vi.useFakeTimers();
    const listeners = new Map<string, Array<(event: KeyboardEvent) => void>>();
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: (event: KeyboardEvent) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
      removeEventListener: (type: string, fn: (event: KeyboardEvent) => void) => listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== fn)),
    });
    useKeymapStore.setState({ preset: 'vscode', overrides: {} });
    const fired: string[] = [];
    const unregister = registerCommandHandlers([
      { id: 'workbench.commandPalette', run: () => fired.push('palette') },
      { id: 'view.keymapSettings', run: () => fired.push('keymap') },
    ]);
    const uninstall = installKeymapDispatcher();
    const key = (code: string) => ({
      code, key: code, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
      isComposing: false, target: null, preventDefault() {}, stopPropagation() {},
    }) as unknown as KeyboardEvent;
    listeners.get('keydown')?.forEach((fn) => fn(key('KeyK')));
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1200);
    expect(fired).toEqual(['palette']);
    fired.length = 0;
    listeners.get('keydown')?.forEach((fn) => fn(key('KeyK')));
    listeners.get('keydown')?.forEach((fn) => fn(key('KeyS')));
    expect(fired).toEqual(['keymap']);
    vi.advanceTimersByTime(1200);
    expect(fired).toEqual(['keymap']);
    uninstall(); unregister();
  });

  it('dispatches double Shift without treating held modifiers as a chord', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'));
    const listeners = new Map<string, Array<(event: KeyboardEvent) => void>>();
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: (event: KeyboardEvent) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
      removeEventListener() {},
    });
    const fired: string[] = [];
    const unregister = registerCommandHandlers([{ id: 'navigate.searchEverywhere', run: () => fired.push('search') }]);
    const uninstall = installKeymapDispatcher();
    const shift = () => ({
      code: 'ShiftLeft', key: 'Shift', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true,
      isComposing: false, target: null, preventDefault() {}, stopPropagation() {},
    }) as unknown as KeyboardEvent;
    listeners.get('keydown')?.forEach((fn) => fn(shift()));
    listeners.get('keyup')?.forEach((fn) => fn(shift()));
    vi.advanceTimersByTime(100);
    listeners.get('keydown')?.forEach((fn) => fn(shift()));
    listeners.get('keyup')?.forEach((fn) => fn(shift()));
    expect(fired).toEqual(['search']);
    uninstall(); unregister();
  });

  it('dispatches a configured side button and suppresses Chromium navigation events', () => {
    vi.useFakeTimers();
    const listeners = new Map<string, EventListener[]>();
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: EventListener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
      removeEventListener: (type: string, fn: EventListener) => listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== fn)),
    });
    useKeymapStore.getState().setBindings('navigate.back', ['Mouse4']);
    const fired: string[] = [];
    const unregister = registerCommandHandlers([{ id: 'navigate.back', run: () => fired.push('back') }]);
    const uninstall = installKeymapDispatcher();
    const mouse = (type: string) => ({
      type, button: 3, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      target: null, preventDefault: vi.fn(), stopPropagation: vi.fn(),
    }) as unknown as MouseEvent;
    const down = mouse('mousedown');
    listeners.get('mousedown')?.forEach((fn) => fn(down));
    expect(fired).toEqual(['back']);
    expect(down.preventDefault).toHaveBeenCalled();
    const up = mouse('mouseup');
    listeners.get('mouseup')?.forEach((fn) => fn(up));
    expect(up.preventDefault).toHaveBeenCalled();
    const aux = mouse('auxclick');
    listeners.get('auxclick')?.forEach((fn) => fn(aux));
    expect(aux.preventDefault).toHaveBeenCalled();
    uninstall(); unregister();
  });

  it('records Alt plus a key as soon as the complete gesture is released', () => {
    const listeners = new Map<string, EventListener[]>();
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: EventListener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
      removeEventListener: (type: string, fn: EventListener) => listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== fn)),
    });
    const committed: string[] = [];
    const dispose = installShortcutRecorder({ onCommit: (binding) => committed.push(binding), onCancel: vi.fn() });
    const key = (type: string, code: string, altKey: boolean) => ({
      type, code, key: code === 'AltLeft' ? 'Alt' : 'k', altKey,
      ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, isComposing: false,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    }) as unknown as KeyboardEvent;
    listeners.get('keydown')?.forEach((fn) => fn(key('keydown', 'AltLeft', true)));
    listeners.get('keydown')?.forEach((fn) => fn(key('keydown', 'KeyK', true)));
    listeners.get('keyup')?.forEach((fn) => fn(key('keyup', 'KeyK', true)));
    expect(committed).toEqual([]);
    listeners.get('keyup')?.forEach((fn) => fn(key('keyup', 'AltLeft', false)));
    expect(committed).toEqual(['Alt+K']);
    dispose();
  });

  it('records Mouse3+ and blocks its full auxiliary-click lifecycle', () => {
    const listeners = new Map<string, EventListener[]>();
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: EventListener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
      removeEventListener: (type: string, fn: EventListener) => listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== fn)),
    });
    const committed: string[] = [];
    const dispose = installShortcutRecorder({ onCommit: (binding) => committed.push(binding), onCancel: vi.fn() });
    const mouse = (type: string, button: number) => ({
      type, button, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    }) as unknown as MouseEvent;
    const down = mouse('mousedown', 4);
    listeners.get('mousedown')?.forEach((fn) => fn(down));
    const up = mouse('mouseup', 4);
    listeners.get('mouseup')?.forEach((fn) => fn(up));
    const aux = mouse('auxclick', 4);
    listeners.get('auxclick')?.forEach((fn) => fn(aux));
    expect(committed).toEqual(['Mouse5']);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(up.preventDefault).toHaveBeenCalled();
    expect(aux.preventDefault).toHaveBeenCalled();
    dispose();
  });
});
