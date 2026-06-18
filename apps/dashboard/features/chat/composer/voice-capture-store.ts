/**
 * Singleton channel between the recorder (inside `MicButton`/`useAudioRecorder`)
 * and the futuristic recording overlay (`VoiceCaptureBar`), which are siblings
 * in the composer tree. Only one recording happens at a time, so a singleton
 * suffices. Holds the live `status` (low-frequency, React-subscribed to mount /
 * unmount the bar) and the `AnalyserNode` (the bar reads it directly to draw the
 * waveform + drive the logo). No per-frame React state — see VoiceCaptureBar.
 */
import { useSyncExternalStore } from 'react';
import type { RecorderStatus } from './useAudioRecorder.js';

interface VoiceCaptureState {
  status: RecorderStatus;
  analyser: AnalyserNode | null;
}

let state: VoiceCaptureState = { status: 'idle', analyser: null };
const listeners = new Set<() => void>();
// The active recorder registers its `stop` here so the overlay's Stop button
// (a composer-level sibling) can end the recording without a prop drill.
let stopFn: (() => void) | null = null;

export function setVoiceCaptureStop(fn: (() => void) | null): void {
  stopFn = fn;
}

export function requestVoiceCaptureStop(): void {
  stopFn?.();
}

function emit(): void {
  for (const l of listeners) l();
}

export function getVoiceCapture(): VoiceCaptureState {
  return state;
}

export function subscribeVoiceCapture(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function publishVoiceCapture(next: Partial<VoiceCaptureState>): void {
  state = { ...state, ...next };
  emit();
}

/**
 * Clear the analyser only if it is still the one passed — guards the dual-mount
 * case where a second recorder instance tears down without clobbering the
 * instance that actually owns the live capture.
 */
export function clearVoiceCaptureAnalyser(node: AnalyserNode | null): void {
  if (node && state.analyser === node) {
    state = { ...state, analyser: null };
    emit();
  }
}

export function useVoiceCaptureStatus(): RecorderStatus {
  return useSyncExternalStore(
    subscribeVoiceCapture,
    () => state.status,
    () => 'idle' as RecorderStatus,
  );
}
