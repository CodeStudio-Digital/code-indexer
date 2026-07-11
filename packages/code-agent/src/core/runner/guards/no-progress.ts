/** Cross-turn, post-result no-progress observation. Never hard-blocks. */
import { createHash } from 'node:crypto';
import type { GuardVerdict, ToolRepeatPolicy } from '@mcp/code-agent/core/tool.js';
import { invocationGuardKey } from './tuple-hash-dedup.js';

interface Observation {
  resultFingerprint: string;
  stateEpoch: number;
  count: number;
  lastTurn: number;
  originToolUseId: string;
}

export interface ObserveNoProgressArgs {
  name: string;
  normalizedInput: unknown;
  content: string;
  isError: boolean;
  turn: number;
  toolUseId: string;
  repeatPolicy: ToolRepeatPolicy;
  resultNovel?: boolean;
  coverageNovel?: boolean;
  productive?: boolean;
  stateEpoch?: number;
}

/**
 * Tracks repeated identical results at a stable workspace epoch. It emits a
 * `shadow` verdict after two later turns repeat the same result, giving the
 * dashboard evidence without recreating the old pre-result refusal trap.
 */
export class NoProgressTracker {
  private readonly observations = new Map<string, Observation>();
  stateEpoch = 0;

  noteStateChange(): number {
    this.stateEpoch += 1;
    this.observations.clear();
    return this.stateEpoch;
  }

  observe(args: ObserveNoProgressArgs): GuardVerdict | null {
    if (
      args.normalizedInput &&
      typeof args.normalizedInput === 'object' &&
      (args.normalizedInput as Record<string, unknown>).force_reread === true
    ) return null;
    if (args.repeatPolicy === 'pollable' || args.repeatPolicy === 'mutating' || args.isError) return null;
    const key = invocationGuardKey(args.name, args.normalizedInput);
    const stateEpoch = args.stateEpoch ?? this.stateEpoch;
    const resultFingerprint = fingerprint(args.content);
    // Novel output/coverage is real progress, but it is also the baseline from
    // which two later unchanged cross-turn results can be measured.
    if (args.productive || args.resultNovel || args.coverageNovel) {
      this.observations.set(key, {
        resultFingerprint,
        stateEpoch,
        count: 1,
        lastTurn: args.turn,
        originToolUseId: args.toolUseId,
      });
      return null;
    }
    const previous = this.observations.get(key);
    const same = previous &&
      previous.stateEpoch === stateEpoch &&
      previous.resultFingerprint === resultFingerprint;
    const count = same && previous.lastTurn < args.turn ? previous.count + 1 : 1;
    const observation: Observation = {
      resultFingerprint,
      stateEpoch,
      count,
      lastTurn: args.turn,
      originToolUseId: same ? previous.originToolUseId : args.toolUseId,
    };
    this.observations.set(key, observation);

    if (count < 3) return null;
    return {
      action: 'shadow',
      reason: 'cross-turn-no-progress',
      shouldReflect: false,
      affectsFailureStreak: false,
      count,
      sourceTool: args.name,
      originToolUseId: observation.originToolUseId,
      wouldBlock: true,
      stateEpoch,
    };
  }

  clear(): void {
    this.observations.clear();
  }
}

function fingerprint(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 16);
}
