import { create } from 'zustand';

const TOGGLE_KEY = 'mcp-ide:ai-complete';

export interface AiCompleteIssue {
  kind: 'unconfigured' | 'manual_only' | 'timeout' | 'provider_error';
  /** Human-readable cause from the server (model name, suggested fix). */
  message?: string;
}

/** One-shot chip popover: setup CTA or "how to enable" hint. */
export type AiCompleteNudge = 'unconfigured' | 'enable-hint' | 'enabled-hint' | null;

interface AiCompleteState {
  enabled: boolean;
  busy: boolean;
  /** Last failure — the chip surfaces it so silent snoozes stay explainable. */
  issue: AiCompleteIssue | null;
  /** Ghost text currently on screen (chip pulse affordance). */
  suggestionVisible: boolean;
  nudge: AiCompleteNudge;
  setEnabled: (on: boolean) => void;
  setBusy: (busy: boolean) => void;
  setIssue: (issue: AiCompleteIssue | null) => void;
  setSuggestionVisible: (visible: boolean) => void;
  requestNudge: (nudge: AiCompleteNudge) => void;
}

type ToggleEffect = (enabled: boolean) => void;
let toggleEffect: ToggleEffect | null = null;

/**
 * Keeps provider-only cancellation/cooldown work out of this lightweight UI
 * store. The completion engine registers the effect while its module is live.
 */
export function registerAiCompleteToggleEffect(effect: ToggleEffect): () => void {
  toggleEffect = effect;
  return () => {
    if (toggleEffect === effect) toggleEffect = null;
  };
}

/**
 * True when the user never touched the toggle — the guided setup flow
 * auto-enables ONLY in that case (an explicit '0' is an explicit no).
 */
export function aiCompleteToggleUnset(): boolean {
  try { return localStorage.getItem(TOGGLE_KEY) === null; } catch { return false; }
}

function initialEnabled(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(TOGGLE_KEY) === '1'; } catch { return false; }
}

export const useAiCompleteStore = create<AiCompleteState>((set) => ({
  enabled: initialEnabled(),
  busy: false,
  issue: null,
  suggestionVisible: false,
  nudge: null,
  setEnabled: (on) => {
    try { localStorage.setItem(TOGGLE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
    toggleEffect?.(on);
    set({ enabled: on, issue: null, nudge: null });
  },
  setBusy: (busy) => set({ busy }),
  setIssue: (issue) => set({ issue }),
  setSuggestionVisible: (visible) => set({ suggestionVisible: visible }),
  requestNudge: (nudge) => set({ nudge }),
}));
