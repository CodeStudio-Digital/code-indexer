/**
 * Tests for the SupervisionState machine (Sprint 4 Phase 1.1).
 *
 * Locks in:
 *   - Transition table covers every state
 *   - isLegalTransition: legal pairs pass, illegal rejected
 *   - Same-state "transition" (heartbeat refresh) always legal
 *   - STUCK_VARIANT_OF maps every transient state with a timeout
 *   - DEFAULT_STATE_TIMEOUT_MS has every enum value (no missing keys)
 *   - TERMINAL is a true sink (no outbound transitions)
 *   - isStuckState / isTerminalState helpers
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATE_TIMEOUT_MS,
  LEGAL_TRANSITIONS,
  STUCK_VARIANT_OF,
  isLegalTransition,
  isStuckState,
  isTerminalState,
  type SupervisionState,
} from '../state-machine.js';

const ALL_STATES: SupervisionState[] = [
  'BOOTING',
  'RUNNING_TURN',
  'AWAITING_PROVIDER',
  'AWAITING_TOOL',
  'AWAITING_MASTER_APPROVAL',
  'AWAITING_INBOX_ANSWER',
  'IDLE',
  'RESURRECTING',
  'QUARANTINED',
  'TERMINAL',
  'STUCK_BOOT',
  'STUCK_TURN',
  'STUCK_PROVIDER',
  'STUCK_TOOL',
  'STUCK_AWAITING_MASTER',
  'INBOX_EXPIRED',
  'FAILED_BOOT',
  'FAILED_RESURRECT',
];

describe('SupervisionState — tables completeness', () => {
  it('DEFAULT_STATE_TIMEOUT_MS has an entry for every state', () => {
    for (const s of ALL_STATES) {
      expect(s in DEFAULT_STATE_TIMEOUT_MS).toBe(true);
    }
  });

  it('LEGAL_TRANSITIONS has an entry for every state', () => {
    for (const s of ALL_STATES) {
      expect(s in LEGAL_TRANSITIONS).toBe(true);
    }
  });

  it('all 6 transient-with-timeout states are in STUCK_VARIANT_OF', () => {
    expect(STUCK_VARIANT_OF.BOOTING).toBe('STUCK_BOOT');
    expect(STUCK_VARIANT_OF.RUNNING_TURN).toBe('STUCK_TURN');
    expect(STUCK_VARIANT_OF.AWAITING_PROVIDER).toBe('STUCK_PROVIDER');
    expect(STUCK_VARIANT_OF.AWAITING_TOOL).toBe('STUCK_TOOL');
    expect(STUCK_VARIANT_OF.AWAITING_MASTER_APPROVAL).toBe('STUCK_AWAITING_MASTER');
    expect(STUCK_VARIANT_OF.AWAITING_INBOX_ANSWER).toBe('INBOX_EXPIRED');
    expect(STUCK_VARIANT_OF.RESURRECTING).toBe('FAILED_RESURRECT');
  });

  it('IDLE and TERMINAL have null timeout (never go stuck)', () => {
    expect(DEFAULT_STATE_TIMEOUT_MS.IDLE).toBeNull();
    expect(DEFAULT_STATE_TIMEOUT_MS.TERMINAL).toBeNull();
  });

  it('STUCK_VARIANT_OF only contains transient states with timeouts', () => {
    for (const from of Object.keys(STUCK_VARIANT_OF) as SupervisionState[]) {
      expect(DEFAULT_STATE_TIMEOUT_MS[from]).not.toBeNull();
    }
  });
});

describe('isLegalTransition', () => {
  it('same-state transitions always legal (heartbeat refresh)', () => {
    for (const s of ALL_STATES) {
      expect(isLegalTransition(s, s)).toBe(true);
    }
  });

  it('TERMINAL is a sink — no outbound transitions', () => {
    expect(LEGAL_TRANSITIONS.TERMINAL.size).toBe(0);
    for (const to of ALL_STATES) {
      if (to === 'TERMINAL') continue;
      expect(isLegalTransition('TERMINAL', to)).toBe(false);
    }
  });

  it('BOOTING happy path: BOOTING → RUNNING_TURN', () => {
    expect(isLegalTransition('BOOTING', 'RUNNING_TURN')).toBe(true);
  });

  it('BOOTING failure: BOOTING → FAILED_BOOT', () => {
    expect(isLegalTransition('BOOTING', 'FAILED_BOOT')).toBe(true);
  });

  it('BOOTING → AWAITING_TOOL is illegal (skips RUNNING_TURN)', () => {
    expect(isLegalTransition('BOOTING', 'AWAITING_TOOL')).toBe(false);
  });

  it('RUNNING_TURN → AWAITING_* is always legal', () => {
    expect(isLegalTransition('RUNNING_TURN', 'AWAITING_PROVIDER')).toBe(true);
    expect(isLegalTransition('RUNNING_TURN', 'AWAITING_TOOL')).toBe(true);
    expect(isLegalTransition('RUNNING_TURN', 'AWAITING_MASTER_APPROVAL')).toBe(true);
    expect(isLegalTransition('RUNNING_TURN', 'AWAITING_INBOX_ANSWER')).toBe(true);
  });

  it('AWAITING_TOOL → RUNNING_TURN is legal (tool returned)', () => {
    expect(isLegalTransition('AWAITING_TOOL', 'RUNNING_TURN')).toBe(true);
  });

  it('AWAITING_TOOL → IDLE is illegal (must go through RUNNING_TURN)', () => {
    expect(isLegalTransition('AWAITING_TOOL', 'IDLE')).toBe(false);
  });

  it('STUCK_TOOL → RUNNING_TURN is legal (tool aborted, runner continued)', () => {
    expect(isLegalTransition('STUCK_TOOL', 'RUNNING_TURN')).toBe(true);
  });

  it('STUCK_TOOL → RESURRECTING is legal (recovery action)', () => {
    expect(isLegalTransition('STUCK_TOOL', 'RESURRECTING')).toBe(true);
  });

  it('RESURRECTING → RUNNING_TURN on recovery success', () => {
    expect(isLegalTransition('RESURRECTING', 'RUNNING_TURN')).toBe(true);
  });

  it('RESURRECTING → QUARANTINED on circuit breaker', () => {
    expect(isLegalTransition('RESURRECTING', 'QUARANTINED')).toBe(true);
  });

  it('QUARANTINED → IDLE after cooldown', () => {
    expect(isLegalTransition('QUARANTINED', 'IDLE')).toBe(true);
  });

  it('QUARANTINED → RUNNING_TURN is illegal (must release quarantine first)', () => {
    expect(isLegalTransition('QUARANTINED', 'RUNNING_TURN')).toBe(false);
  });

  it('INBOX_EXPIRED → IDLE is legal (sender unblocks)', () => {
    expect(isLegalTransition('INBOX_EXPIRED', 'IDLE')).toBe(true);
  });

  it('any state → TERMINAL is generally legal (except terminal itself, which is no-op via same-state)', () => {
    // Most non-terminal states can transition to TERMINAL
    const expectTerminalReachable: SupervisionState[] = [
      'BOOTING',
      'RUNNING_TURN',
      'AWAITING_PROVIDER',
      'AWAITING_TOOL',
      'AWAITING_MASTER_APPROVAL',
      'AWAITING_INBOX_ANSWER',
      'IDLE',
      'RESURRECTING',
      'QUARANTINED',
      'STUCK_BOOT',
      'STUCK_TURN',
      'STUCK_PROVIDER',
      'STUCK_TOOL',
      'STUCK_AWAITING_MASTER',
      'INBOX_EXPIRED',
      'FAILED_BOOT',
      'FAILED_RESURRECT',
    ];
    for (const from of expectTerminalReachable) {
      expect(isLegalTransition(from, 'TERMINAL')).toBe(true);
    }
  });

  it('rejects fabricated state names', () => {
    expect(isLegalTransition('NOT_A_STATE' as SupervisionState, 'IDLE')).toBe(false);
  });
});

describe('isStuckState', () => {
  it('returns true for STUCK_* + FAILED_* + INBOX_EXPIRED', () => {
    expect(isStuckState('STUCK_BOOT')).toBe(true);
    expect(isStuckState('STUCK_TURN')).toBe(true);
    expect(isStuckState('STUCK_PROVIDER')).toBe(true);
    expect(isStuckState('STUCK_TOOL')).toBe(true);
    expect(isStuckState('STUCK_AWAITING_MASTER')).toBe(true);
    expect(isStuckState('INBOX_EXPIRED')).toBe(true);
    expect(isStuckState('FAILED_BOOT')).toBe(true);
    expect(isStuckState('FAILED_RESURRECT')).toBe(true);
  });

  it('returns false for healthy/transient states', () => {
    expect(isStuckState('BOOTING')).toBe(false);
    expect(isStuckState('RUNNING_TURN')).toBe(false);
    expect(isStuckState('IDLE')).toBe(false);
    expect(isStuckState('TERMINAL')).toBe(false);
    expect(isStuckState('RESURRECTING')).toBe(false);
    expect(isStuckState('QUARANTINED')).toBe(false);
  });
});

describe('isTerminalState', () => {
  it('only TERMINAL is terminal', () => {
    expect(isTerminalState('TERMINAL')).toBe(true);
    for (const s of ALL_STATES) {
      if (s === 'TERMINAL') continue;
      expect(isTerminalState(s)).toBe(false);
    }
  });
});
