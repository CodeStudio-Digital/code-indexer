import { randomUUID } from 'node:crypto';
import { SessionOperationConflictError } from '../session-writer.js';
import { parseCoderTurnPayload, projectConversation, requestKey, toJsonValue } from './conversation-codec.js';
import { FsSessionDirectory } from './session-directory.js';
import { hostOutcomeOccurrenceId, hostOutcomeRequestKey, validateHostOutcomeIncident, validateOutcomeEvidence } from './tool-outcome-projection.js';
import type { FsCoderTurnPayload } from './types.js';
import type { FsResolveToolOutcomeInput, FsResolveToolOutcomeResult, FsToolOutcomeResolutionRecord,
  FsToolOutcomeState, FsRecordToolOutcomeIncidentInput, FsRecordToolOutcomeIncidentResult,
  FsToolOutcomeIncidentRecord } from './tool-outcome-types.js';
import type { SessionId } from '../types.js';

function keyFor(input: Pick<FsResolveToolOutcomeInput, 'toolUseId' | 'expectedOccurrenceIds' | 'resolution'>): string {
  return requestKey({ type: 'resolve-tool-outcome', toolUseId: input.toolUseId,
    expectedOccurrenceIds: [...input.expectedOccurrenceIds].sort(), resolution: input.resolution });
}

export class FsToolOutcomeRepository {
  constructor(private readonly directory: FsSessionDirectory) {}

  /** Host-only observations from children/imported histories may precede any
   * parent assistant checkpoint. Sequence zero is explicitly not a chat row. */
  async recordToolOutcomeIncident(input: FsRecordToolOutcomeIncidentInput): Promise<FsRecordToolOutcomeIncidentResult> {
    if (input.args === undefined) throw new TypeError('Host tool outcome arguments must be explicit JSON, including null for unknown arguments');
    const args = toJsonValue(input.args);
    const key = hostOutcomeRequestKey({ ...input, args });
    const record: FsToolOutcomeIncidentRecord = { schema_version: 1,
      operationId: input.operationId, occurrenceId: hostOutcomeOccurrenceId(input.operationId, key),
      toolUseId: input.toolUseId, toolName: input.toolName, args, messageSeq: 0,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      sourceReference: input.sourceReference, recordedAt: new Date().toISOString() };
    validateHostOutcomeIncident(record);
    return this.directory.runMutation(input.sessionId, async () => {
      const entry = await this.directory.requireEntry(input.sessionId);
      const commits = await this.directory.repository.readConversation(entry.location);
      const existing = commits.find(commit => commit.operation_id === input.operationId);
      if (existing) {
        const payload = parseCoderTurnPayload(existing);
        if (payload.request_key !== key || !payload.tool_outcome_incidents?.some(incident => incident.occurrenceId === record.occurrenceId)) {
          throw new SessionOperationConflictError(`operation_id ${input.operationId} was already committed with different input`);
        }
        const state = projectConversation(commits).toolOutcomes;
        return { incident: state.incidents.find(incident => incident.occurrenceId === record.occurrenceId)!, state };
      }
      const payload: FsCoderTurnPayload = { schema_version: 1, type: 'coder.turn', request_key: key,
        messages: [], message_patches: [], tool_calls: [], tool_outcome_incidents: [record] };
      await this.directory.repository.commitTurn(entry.location, { operation_id: input.operationId, payload: toJsonValue(payload) });
      const state = projectConversation(await this.directory.repository.readConversation(entry.location)).toolOutcomes;
      return { incident: state.incidents.find(incident => incident.occurrenceId === record.occurrenceId)!, state };
    });
  }

  async getToolOutcomeState(id: SessionId | string): Promise<FsToolOutcomeState> {
    const entry = await this.directory.requireEntry(id);
    // This is a read-only endpoint: never acquire a writer lease just to show
    // incidents while another process owns the running session.
    return projectConversation(await this.directory.repository.readConversation(entry.location)).toolOutcomes;
  }

  async resolveToolOutcome(input: FsResolveToolOutcomeInput): Promise<FsResolveToolOutcomeResult> {
    if (typeof input.operationId !== 'string' || !input.operationId.trim() || input.operationId.length > 512 || input.operationId.includes('\0')) {
      throw new TypeError('operationId must be a non-empty opaque string');
    }
    if (typeof input.toolUseId !== 'string' || !input.toolUseId.trim() || input.toolUseId.length > 1024 || input.toolUseId.includes('\0')
      || !Array.isArray(input.expectedOccurrenceIds) || !input.expectedOccurrenceIds.length || input.expectedOccurrenceIds.length > 10000
      || input.expectedOccurrenceIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 512)
      || new Set(input.expectedOccurrenceIds).size !== input.expectedOccurrenceIds.length) {
      throw new TypeError('A tool outcome resolution must name its expected occurrences');
    }
    validateOutcomeEvidence(input.resolution?.kind, input.resolution?.evidence);
    return this.directory.runMutation(input.sessionId, async () => {
      const entry = await this.directory.requireEntry(input.sessionId);
      const commits = await this.directory.repository.readConversation(entry.location);
      const state = projectConversation(commits).toolOutcomes;
      const key = keyFor(input);
      const existing = commits.find(commit => commit.operation_id === input.operationId);
      if (existing) {
        const payload = parseCoderTurnPayload(existing);
        const resolution = payload.tool_outcome_resolutions?.[0];
        if (payload.request_key !== key || !resolution) {
          throw new SessionOperationConflictError(`operation_id ${input.operationId} was already committed with different input`);
        }
        return { resolution, state };
      }
      // Identical evidence may be submitted again with a fresh request ID by a
      // restarted client. Reuse the original record; never append a second vote.
      const duplicate = state.resolved.find(record => keyFor({ toolUseId: record.toolUseId,
        expectedOccurrenceIds: record.occurrenceIds, resolution: { kind: record.kind, evidence: record.evidence } }) === key);
      if (duplicate) return { resolution: duplicate, state };
      const pending = state.pending.filter(incident => incident.toolUseId === input.toolUseId);
      if (!pending.length && !state.resolved.some(record => record.toolUseId === input.toolUseId)) {
        throw new RangeError(`Unknown tool outcome ${input.toolUseId}`);
      }
      const expected = [...input.expectedOccurrenceIds].sort();
      const actual = pending.map(incident => incident.occurrenceId).sort();
      if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
        throw new SessionOperationConflictError('Tool outcome occurrences changed; refresh the incident before resolving it');
      }
      const resolution: FsToolOutcomeResolutionRecord = {
        schema_version: 1, id: randomUUID(), operationId: input.operationId,
        toolUseId: input.toolUseId, occurrenceIds: expected,
        kind: input.resolution.kind, evidence: { ...input.resolution.evidence }, recordedAt: new Date().toISOString(),
      };
      const payload: FsCoderTurnPayload = { schema_version: 1, type: 'coder.turn', request_key: key,
        messages: [], message_patches: [], tool_calls: [], tool_outcome_resolutions: [resolution] };
      await this.directory.repository.commitTurn(entry.location, { operation_id: input.operationId, payload: toJsonValue(payload) });
      // Only the named occurrences were resolved. Even a repository-level
      // append racing this mutation cannot clear a newly observed occurrence.
      return { resolution, state: projectConversation(await this.directory.repository.readConversation(entry.location)).toolOutcomes };
    });
  }
}
