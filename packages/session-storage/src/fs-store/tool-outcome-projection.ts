import { isUuid, type JsonValue } from '../types.js';
import { computeRequestHash } from '../session-writer.js';
import type { FsCoderTurnPayload, FsToolCallRecord } from './types.js';
import type { FsToolOutcomeEvidence, FsToolOutcomeIncident, FsToolOutcomeResolutionKind,
  FsToolOutcomeResolutionRecord, FsToolOutcomeState, FsToolOutcomeIncidentRecord,
  FsRecordToolOutcomeIncidentInput } from './tool-outcome-types.js';

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function hostOutcomeRequestKey(input: Pick<FsRecordToolOutcomeIncidentInput, 'toolUseId' | 'toolName' | 'args' | 'runId' | 'sourceReference'>): string {
  return computeRequestHash({ type: 'record-tool-outcome-incident', toolUseId: input.toolUseId,
    toolName: input.toolName, args: input.args, runId: input.runId ?? null, sourceReference: input.sourceReference });
}
export function hostOutcomeOccurrenceId(operationId: string, boundHash: string): string {
  return `host:${computeRequestHash({ operationId, boundHash })}`;
}
export function validateHostOutcomeIncident(record: FsToolOutcomeIncidentRecord): void {
  if (!record || record.schema_version !== 1 || record.messageSeq !== 0 || record.toolCallId !== undefined
    || typeof record.operationId !== 'string' || !record.operationId.trim() || record.operationId.length > 512 || record.operationId.includes('\0')
    || typeof record.toolUseId !== 'string' || !record.toolUseId.trim() || record.toolUseId.length > 1024 || record.toolUseId.includes('\0')
    || typeof record.toolName !== 'string' || !record.toolName.trim() || record.toolName.length > 512
    || typeof record.sourceReference !== 'string' || !record.sourceReference.trim() || record.sourceReference.length > 2048
    || record.args === undefined
    || (record.runId !== undefined && (typeof record.runId !== 'string' || !record.runId.trim() || record.runId.length > 512))
    || typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt))
    || record.occurrenceId !== hostOutcomeOccurrenceId(record.operationId, hostOutcomeRequestKey(record))) {
    throw new TypeError('Invalid host tool outcome incident');
  }
}
export function validateOutcomeEvidence(kind: FsToolOutcomeResolutionKind, evidence: FsToolOutcomeEvidence): void {
  if (!['verified_terminal', 'verified_not_applied', 'user_acknowledged'].includes(kind)) throw new TypeError('Invalid tool outcome resolution kind');
  if (!evidence || !['host_receipt', 'native_read_only', 'user_review'].includes(evidence.source)
    || typeof evidence.summary !== 'string' || !evidence.summary.trim() || evidence.summary.length > 8192
    || (evidence.reference !== undefined && (typeof evidence.reference !== 'string' || !evidence.reference.trim() || evidence.reference.length > 2048))) {
    throw new TypeError('Invalid tool outcome evidence');
  }
  if ((kind === 'user_acknowledged') !== (evidence.source === 'user_review')) {
    throw new TypeError('User review is an acknowledgement, not technical verification');
  }
}
export function validateOutcomeResolution(record: FsToolOutcomeResolutionRecord): void {
  if (!record || record.schema_version !== 1 || !isUuid(record.id)
    || typeof record.toolUseId !== 'string' || !record.toolUseId.trim()
    || typeof record.operationId !== 'string' || !record.operationId.trim()
    || typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt))
    || !Array.isArray(record.occurrenceIds) || !record.occurrenceIds.length
    || record.occurrenceIds.some(id => typeof id !== 'string' || !id.trim())
    || new Set(record.occurrenceIds).size !== record.occurrenceIds.length) {
    throw new TypeError('Invalid tool outcome resolution record');
  }
  validateOutcomeEvidence(record.kind, record.evidence);
}

/** Safety evidence follows the physical operation, not visible chat rows.
 * Truncation/compaction never removes an unknown effect or invents a receipt. */
export class ToolOutcomeProjection {
  private readonly incidents = new Map<string, FsToolOutcomeIncident>();
  private readonly resolvedOccurrences = new Set<string>();
  private readonly resolutions: FsToolOutcomeResolutionRecord[] = [];
  private readonly resolutionIds = new Set<string>();
  private readonly callsByOutput = new Map<string, FsToolCallRecord>();
  private readonly toolInfo = new Map<string, { toolName: string; args: JsonValue | null }>();
  private readonly messages = new Map<number, { id: string; role: string }>();

  apply(payload: FsCoderTurnPayload): void {
    for (const record of payload.tool_outcome_incidents ?? []) {
      validateHostOutcomeIncident(record);
      if (this.incidents.has(record.occurrenceId)) throw new TypeError('Duplicate host tool outcome occurrence');
      this.incidents.set(record.occurrenceId, { occurrenceId: record.occurrenceId, toolUseId: record.toolUseId,
        toolName: record.toolName, args: record.args, messageSeq: 0, sourceReference: record.sourceReference,
        ...(record.runId ? { runId: record.runId } : {}) });
    }
    for (const call of payload.tool_calls) {
      this.callsByOutput.set(`${call.tool_use_id}\0${call.output.id}`, call);
      this.toolInfo.set(call.tool_use_id, { toolName: call.tool_name, args: call.args });
      if (call.metadata?.effect_outcome === 'unknown') this.observeCall(call);
    }
    for (const patch of payload.message_patches) {
      const previous = this.messages.get(patch.seq);
      if (previous && patch.content !== undefined) this.observeMessage(previous.id, patch.seq, previous.role, patch.content);
    }
    for (const message of payload.messages) {
      this.messages.set(message.seq, { id: message.id, role: message.role });
      this.observeMessage(message.id, message.seq, message.role, message.content);
    }
    for (const resolution of payload.tool_outcome_resolutions ?? []) {
      validateOutcomeResolution(resolution);
      if (this.resolutionIds.has(resolution.id)) throw new TypeError('Duplicate tool outcome resolution ID');
      for (const occurrence of resolution.occurrenceIds) {
        const incident = this.incidents.get(occurrence);
        if (!incident || incident.toolUseId !== resolution.toolUseId) throw new TypeError('Tool outcome resolution targets an unknown occurrence');
        if (this.resolvedOccurrences.has(occurrence)) throw new TypeError('Tool outcome occurrence was already resolved');
      }
      this.resolutionIds.add(resolution.id);
      this.resolutions.push(resolution);
      for (const occurrence of resolution.occurrenceIds) this.resolvedOccurrences.add(occurrence);
    }
  }

  private observeCall(call: FsToolCallRecord): void {
    const occurrenceId = `call:${call.id}`;
    this.incidents.set(occurrenceId, { occurrenceId, toolUseId: call.tool_use_id,
      toolName: call.tool_name, args: call.args, messageSeq: call.message_seq, toolCallId: call.id,
      ...(typeof call.metadata?.run_id === 'string' && call.metadata.run_id ? { runId: call.metadata.run_id } : {}) });
  }

  private observeMessage(id: string, seq: number, role: string, content: JsonValue): void {
    if (!Array.isArray(content)) return;
    content.forEach((value, index) => {
      const block = object(value);
      if (!block) return;
      if (role === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        this.toolInfo.set(block.id, { toolName: block.name, args: (block.input ?? null) as JsonValue });
      }
      if (role !== 'tool' || (block.type !== 'tool_result' && block.type !== 'tool_result_ref')
        || block.effect_outcome !== 'unknown' || typeof block.tool_use_id !== 'string') return;
      const output = object(block.output);
      const pairedCall = typeof output?.id === 'string' ? this.callsByOutput.get(`${block.tool_use_id}\0${output.id}`) : undefined;
      if (pairedCall) { this.observeCall(pairedCall); return; }
      const occurrenceId = `message:${id}:${index}`;
      const info = this.toolInfo.get(block.tool_use_id);
      this.incidents.set(occurrenceId, { occurrenceId, toolUseId: block.tool_use_id,
        toolName: info?.toolName ?? 'unknown', args: info?.args ?? null, messageSeq: seq });
    });
  }

  snapshot(): FsToolOutcomeState {
    const pending = [...this.incidents.values()].filter(incident => !this.resolvedOccurrences.has(incident.occurrenceId));
    const unresolvedToolUseIds = [...new Set(pending.map(incident => incident.toolUseId))];
    const unresolved = new Set(unresolvedToolUseIds);
    return { incidents: [...this.incidents.values()], pending, resolved: [...this.resolutions], unresolvedToolUseIds,
      resolvedToolUseIds: [...new Set(this.resolutions.map(record => record.toolUseId))].filter(id => !unresolved.has(id)) };
  }
}
