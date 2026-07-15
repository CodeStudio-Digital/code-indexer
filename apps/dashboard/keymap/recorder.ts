import { eventToChord, eventToMouseChord, suspendKeymapDispatcher } from './dispatcher.js';

interface ShortcutRecorderOptions {
  onCommit: (binding: string) => void | Promise<void>;
  onCancel: () => void;
}

const blockEvent = (event: Event): void => {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
};

/**
 * Capture one shortcut gesture and finish when every held key/button is up.
 * Keeping a modifier held allows a two-part chord such as Ctrl+K Ctrl+S.
 */
export function installShortcutRecorder({ onCommit, onCancel }: ShortcutRecorderOptions): () => void {
  const pressedKeys = new Set<string>();
  const pressedButtons = new Set<number>();
  const chords: string[] = [];
  let finishing = false;
  const resumeDispatcher = suspendKeymapDispatcher();

  const addChord = (chord: string | null): void => {
    if (!chord || chords.length >= 2 || chords[chords.length - 1] === chord) return;
    chords.push(chord);
  };

  const finish = (): void => {
    if (finishing || chords.length === 0) return;
    finishing = true;
    void onCommit(chords.join(' '));
  };

  const finishWhenReleased = (): void => {
    if (pressedKeys.size === 0 && pressedButtons.size === 0) finish();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (finishing) return;
    blockEvent(event);
    if (event.key === 'Escape') {
      finishing = true;
      onCancel();
      return;
    }
    pressedKeys.add(event.code);
    if (!event.repeat && !event.isComposing) addChord(eventToChord(event));
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (finishing) return;
    blockEvent(event);
    pressedKeys.delete(event.code);
    finishWhenReleased();
  };

  const onMouseDown = (event: MouseEvent): void => {
    if (finishing) return;
    const chord = eventToMouseChord(event);
    if (!chord) return; // Left and right clicks remain normal UI input.
    blockEvent(event);
    pressedButtons.add(event.button);
    addChord(chord);
  };

  const onMouseUp = (event: MouseEvent): void => {
    if (finishing || !eventToMouseChord(event)) return;
    blockEvent(event);
    pressedButtons.delete(event.button);
    finishWhenReleased();
  };

  const onAuxClick = (event: MouseEvent): void => {
    if (!eventToMouseChord(event)) return;
    // Chromium assigns navigation/autoscroll defaults to these buttons.
    blockEvent(event);
  };

  const onBlur = (): void => {
    if (finishing) return;
    pressedKeys.clear();
    pressedButtons.clear();
    finish();
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('mouseup', onMouseUp, true);
  window.addEventListener('auxclick', onAuxClick, true);
  window.addEventListener('blur', onBlur);

  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('mouseup', onMouseUp, true);
    window.removeEventListener('auxclick', onAuxClick, true);
    window.removeEventListener('blur', onBlur);
    resumeDispatcher();
  };
}
