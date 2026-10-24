import { createHash } from 'node:crypto';
import {
  ControlPlaneFileRepository,
  isUuid,
  type EntityRelations,
  type SessionId,
} from '@mcp/session-storage';
import type {
  PolicyShadowCapabilitySetWrite,
  PolicyShadowComparisonWrite,
  PolicyShadowDecisionWrite,
  PolicyShadowPersistencePort,
} from '@mcp/session-storage/policy-shadow-contract.js';
import { classifyPolicyComparison } from '@mcp/session-storage/policy-shadow-contract.js';
import { toJsonValue } from './conversation-codec.js';
import type { FsSessionStore } from './fs-session-store.js';

type PolicySessionStore = Pick<FsSessionStore, 'getSessionLocation'>;

function deterministicUuid(seed: string): string {
  const chars = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  return [
    chars.slice(0, 8).join(''),
    chars.slice(8, 12).join(''),
    chars.slice(12, 16).join(''),
    chars.slice(16, 20).join(''),
    chars.slice(20, 32).join(''),
  ].join('-');
}

function relations(
  sessionId: SessionId,
  agentRunId: string,
  extra: EntityRelations = {},
): EntityRelations {
  return {
    session: sessionId,
    ...(isUuid(agentRunId) ? { run: agentRunId } : {}),
    ...extra,
  };
}

/**
 * Session-bundle implementation of the policy shadow durability port.
 * Every decision, comparison and capability-set checkpoint is an immutable
 * UUID-named JSON envelope. It has no SQLite handle or compatibility path.
 */
export class FsPolicyShadowRepository
implements PolicyShadowPersistencePort {
  private readonly repositories =
    new Map<string, Promise<ControlPlaneFileRepository>>();

  constructor(private readonly sessions: PolicySessionStore) {}

  private repository(
    sessionId: SessionId,
  ): Promise<ControlPlaneFileRepository> {
    if (!isUuid(sessionId)) {
      return Promise.reject(
        new TypeError('policy shadow session id must be a canonical UUID'),
      );
    }
    const key = String(sessionId).toLowerCase();
    let pending = this.repositories.get(key);
    if (!pending) {
      pending = this.sessions.getSessionLocation(sessionId).then((location) => {
        if (!location) {
          throw new Error(`Unknown filesystem session ${String(sessionId)}`);
        }
        return new ControlPlaneFileRepository({
          sessionRoot: location.bundle_path,
        });
      });
      this.repositories.set(key, pending);
      void pending.catch(() => {
        if (this.repositories.get(key) === pending) {
          this.repositories.delete(key);
        }
      });
    }
    return pending;
  }

  async recordDecision(input: PolicyShadowDecisionWrite): Promise<void> {
    const repository = await this.repository(input.sessionId);
    const id = deterministicUuid(
      `policy-decision:${input.sessionId}:${input.decision.decisionId}`,
    );
    await repository.recordPolicyDecision({
      id,
      operationId: id,
      relations: relations(input.sessionId, input.agentRunId),
      data: {
        effect: input.decision.effect,
        reasonCode: input.decision.reasonCode,
        recordType: 'decision',
        decisionId: input.decision.decisionId,
        sessionId: input.sessionId,
        agentRunId: input.agentRunId,
        toolUseId: input.toolUseId,
        capabilityId: input.capabilityId,
        capabilityVersion: input.capabilityVersion,
        policyVersion: input.policyVersion,
        background: input.background,
        decidedAt:
          input.decision.audit.decidedAt ?? new Date().toISOString(),
        decision: toJsonValue(input.decision),
      },
    });
  }

  async recordComparison(
    input: PolicyShadowComparisonWrite,
  ): Promise<void> {
    const repository = await this.repository(input.sessionId);
    const classification = classifyPolicyComparison(
      input.legacyEffect,
      input.shadowEffect,
    );
    const decisionEntityId = deterministicUuid(
      `policy-decision:${input.sessionId}:${input.decisionId}`,
    );
    if (!(await repository.get('policyDecision', decisionEntityId))) {
      throw new Error(
        `Policy comparison references missing decision ${input.decisionId}`,
      );
    }
    const id = deterministicUuid(
      `policy-comparison:${input.sessionId}:${input.comparisonId}`,
    );
    await repository.recordPolicyDecision({
      id,
      operationId: id,
      relations: relations(input.sessionId, input.agentRunId, {
        decision: decisionEntityId,
      }),
      data: {
        effect: input.shadowEffect,
        reasonCode:
          classification.divergenceKind ??
          (classification.agreement ? 'agreement' : 'divergence'),
        recordType: 'comparison',
        comparisonId: input.comparisonId,
        decisionId: input.decisionId,
        sessionId: input.sessionId,
        agentRunId: input.agentRunId,
        toolUseId: input.toolUseId,
        capabilityId: input.capabilityId,
        legacyEffect: input.legacyEffect,
        shadowEffect: input.shadowEffect,
        agreement: classification.agreement,
        divergenceKind: classification.divergenceKind,
        critical: classification.critical,
        comparedAt: input.comparedAt,
        evaluationMs: input.evaluationMs,
      },
    });
  }

  async recordCapabilitySet(
    input: PolicyShadowCapabilitySetWrite,
  ): Promise<void> {
    const repository = await this.repository(input.sessionId);
    const id = deterministicUuid(
      [
        'policy-capability-set',
        input.sessionId,
        input.agentRunId,
        input.set.ref,
      ].join(':'),
    );
    await repository.createCheckpoint({
      id,
      operationId: id,
      relations: relations(input.sessionId, input.agentRunId),
      data: {
        checkpointType: 'resolved_capability_set',
        recordType: 'resolved_capability_set',
        sessionId: input.sessionId,
        agentRunId: input.agentRunId,
        capabilitySet: toJsonValue(input.set),
        descriptors: toJsonValue(input.descriptors),
      },
    });
  }
}
