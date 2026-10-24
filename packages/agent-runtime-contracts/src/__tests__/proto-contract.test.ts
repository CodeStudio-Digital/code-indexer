import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const protoRoot = resolve(packageRoot, 'proto');
const v1Root = resolve(protoRoot, 'codestudio/agent/v1');

function readProto(name: string): string {
  return readFileSync(resolve(v1Root, name), 'utf8');
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function namedBlocks(source: string, kind: 'message' | 'enum'): Map<string, string> {
  const clean = stripComments(source);
  const blocks = new Map<string, string>();
  const declaration = new RegExp(`\\b${kind}\\s+(\\w+)\\s*\\{`, 'g');

  for (let match = declaration.exec(clean); match !== null; match = declaration.exec(clean)) {
    let depth = 1;
    let cursor = declaration.lastIndex;
    while (cursor < clean.length && depth > 0) {
      if (clean[cursor] === '{') depth += 1;
      if (clean[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    expect(depth, `${kind} ${match[1]} must have balanced braces`).toBe(0);
    blocks.set(match[1], clean.slice(declaration.lastIndex, cursor - 1));
    declaration.lastIndex = cursor;
  }

  return blocks;
}

function fieldTags(messageBody: string): Map<string, number> {
  const tags = new Map<string, number>();
  const field = /^\s*(?:optional\s+|repeated\s+)?[\w.<>]+\s+(\w+)\s*=\s*(\d+)\s*;/gm;
  for (let match = field.exec(messageBody); match !== null; match = field.exec(messageBody)) {
    tags.set(match[1], Number(match[2]));
  }
  return tags;
}

describe('Rust agent V1 Protobuf contract', () => {
  const common = readProto('common.proto');
  const artifact = readProto('artifact.proto');
  const capability = readProto('capability.proto');
  const runtime = readProto('runtime.proto');
  const runnerBootstrap = readProto('runner_bootstrap.proto');
  const sessionStore = readProto('session_store.proto');
  const supervisor = readProto('supervisor.proto');
  const sources = [
    common,
    artifact,
    capability,
    runtime,
    runnerBootstrap,
    sessionStore,
    supervisor,
  ];

  it('uses the versioned package and resolves every local import', () => {
    for (const source of sources) {
      expect(source).toMatch(/syntax = "proto3";/);
      expect(source).toMatch(/package codestudio\.agent\.v1;/);
    }

    const runtimeImports = [...runtime.matchAll(/import "([^"]+)";/g)].map((match) => match[1]);
    expect(runtimeImports).toEqual([
      'codestudio/agent/v1/artifact.proto',
      'codestudio/agent/v1/capability.proto',
      'codestudio/agent/v1/common.proto',
      'codestudio/agent/v1/session_store.proto',
    ]);
    const capabilityImports = [
      ...capability.matchAll(/import "([^"]+)";/g),
    ].map((match) => match[1]);
    expect(capabilityImports).toEqual(['codestudio/agent/v1/common.proto']);
    const supervisorImports = [...supervisor.matchAll(/import "([^"]+)";/g)].map(
      (match) => match[1],
    );
    expect(supervisorImports).toEqual(['codestudio/agent/v1/common.proto']);
    const runnerBootstrapImports = [
      ...runnerBootstrap.matchAll(/import "([^"]+)";/g),
    ].map((match) => match[1]);
    expect(runnerBootstrapImports).toEqual([
      'codestudio/agent/v1/common.proto',
      'codestudio/agent/v1/supervisor.proto',
    ]);
    const sessionStoreImports = [
      ...sessionStore.matchAll(/import "([^"]+)";/g),
    ].map((match) => match[1]);
    expect(sessionStoreImports).toEqual(['codestudio/agent/v1/common.proto',
      'codestudio/agent/v1/artifact.proto', 'codestudio/agent/v1/supervisor_bootstrap.proto']);

    for (const imported of [
      ...runtimeImports,
      ...capabilityImports,
      ...runnerBootstrapImports,
      ...sessionStoreImports,
      ...supervisorImports,
    ]) {
      expect(() => readFileSync(resolve(protoRoot, imported), 'utf8')).not.toThrow();
    }
  });

  it('hashes the encoded management payload before decoding its oneof', () => {
    const messages = namedBlocks(supervisor, 'message');
    expect(Object.fromEntries(fieldTags(messages.get('ManagementFrameHeader')!))).toEqual({
      protocol_version: 1,
      connection_id: 2,
      message_id: 3,
      reply_to_message_id: 4,
      stream_seq: 5,
      sent_at_unix_ms: 6,
      deadline_at_unix_ms: 7,
      payload_sha256: 8,
    });
    expect(Object.fromEntries(fieldTags(messages.get('ManagementFrame')!))).toEqual({
      header: 1,
      encoded_payload: 2,
    });
    expect(messages.get('ManagementFrame')).not.toContain('oneof');
    expect(Object.fromEntries(fieldTags(messages.get('ManagementPayload')!))).toEqual({
      host_supervisor_hello: 10,
      supervisor_hello: 11,
      launch_attempt_process: 12,
      launch_accepted: 13,
      launch_rejected: 14,
      attempt_process_spawned: 15,
      attempt_containment_report: 16,
      update_attempt_authority: 17,
      cancel_attempt_process: 18,
      fence_attempt_process: 19,
      reap_attempt_process: 20,
      attempt_process_exited: 21,
      attempt_process_reaped: 22,
      query_supervisor_state: 23,
      supervisor_state: 24,
      shutdown_supervisor: 25,
      supervisor_resource_sample: 26,
      supervisor_fault: 27,
      management_ack: 28,
    });
  });

  it('binds every physical launch to authority, budget, deadline, nonce and provenance', () => {
    const messages = namedBlocks(supervisor, 'message');
    expect(Object.fromEntries(fieldTags(messages.get('LaunchAttemptProcess')!))).toEqual({
      identity: 1,
      resource_budget: 2,
      hard_deadline_at_unix_ms: 3,
      authority_lease_expires_at_unix_ms: 4,
      launch_nonce: 5,
      protected_endpoints: 6,
      expected_runner_provenance: 7,
      idempotency_key: 8,
      required_enforced_limits: 9,
      activation_authority_seal: 10,
    });

    for (const mutation of [
      'LaunchAttemptProcess',
      'LaunchAccepted',
      'LaunchRejected',
      'AttemptProcessSpawned',
      'AttemptContainmentReport',
      'UpdateAttemptAuthority',
      'CancelAttemptProcess',
      'FenceAttemptProcess',
      'ReapAttemptProcess',
      'AttemptProcessExited',
      'AttemptProcessReaped',
      'AttemptProcessSnapshot',
    ]) {
      expect(fieldTags(messages.get(mutation)!).get('identity'), mutation).toBe(1);
    }

    expect(messages.get('LaunchAttemptProcess')).toMatch(
      /repeated\s+ProtectedAttemptEndpoint\s+protected_endpoints\s*=\s*6\s*;/,
    );
    expect(messages.get('ProtectedAttemptEndpoint')).toMatch(
      /string\s+connection_id\s*=\s*6\s*;/,
    );
    expect(messages.get('LaunchAttemptProcess')).toMatch(
      /ExpectedRuntimeProvenance\s+expected_runner_provenance\s*=\s*7\s*;/,
    );
    expect(messages.get('LaunchAttemptProcess')).toMatch(
      /repeated\s+ResourceLimitKind\s+required_enforced_limits\s*=\s*9\s*;/,
    );
    expect(messages.get('LaunchAttemptProcess')).toMatch(
      /ActivationAuthoritySeal\s+activation_authority_seal\s*=\s*10\s*;/,
    );
    expect(Object.fromEntries(
      fieldTags(namedBlocks(common, 'message').get('ActivationAuthoritySeal')!),
    )).toEqual({
      agent_run_version: 1,
      attempt_version: 2,
      activation_nonce_sha256: 3,
    });
    expect(messages.get('AttemptProcessSpawned')).toMatch(
      /RuntimeProvenance\s+runner_provenance\s*=\s*2\s*;/,
    );
  });

  it('keeps the single-use runner bootstrap explicit and outside management', () => {
    const messages = namedBlocks(runnerBootstrap, 'message');
    expect(Object.fromEntries(fieldTags(messages.get('RunnerLaunchEndpoint')!))).toEqual({
      kind: 1,
      endpoint_id: 2,
      address: 3,
      connection_id: 4,
      connection_token: 5,
      max_frame_bytes: 6,
      provisioning: 7,
      listener_slot: 8,
      expected_peer_role: 9,
    });
    expect(Object.fromEntries(fieldTags(messages.get('RunnerLaunchHandoff')!))).toEqual({
      schema_version: 1,
      identity: 2,
      runtime_instance_id: 3,
      runner_process_id: 4,
      endpoints: 5,
      launch_nonce: 6,
      hard_deadline_at_unix_ms: 7,
      reserved_resource_budget: 8,
      effective_containment: 9,
      launch_management_payload_sha256: 10,
      expected_host_peer: 11,
      expected_supervisor_peer: 12,
      activation_authority_seal: 13,
      runtime_provenance: 14,
      runner_pulse_interval_ms: 15,
    });
    expect(Object.fromEntries(fieldTags(messages.get('RunnerEndpointsReady')!))).toEqual({
      schema_version: 1,
      identity: 2,
      runtime_instance_id: 3,
      runner_process_id: 4,
      acknowledged_handoff_sha256: 5,
      endpoints: 6,
    });

    const management = namedBlocks(supervisor, 'message').get('ManagementPayload')!;
    expect(management).not.toContain('RunnerLaunchHandoff');
    expect(management).not.toContain('RunnerEndpointsReady');
    expect(runnerBootstrap).not.toMatch(/\b(?:prompt|transcript|provider|tool|artifact_body)\b/);
  });

  it('represents reaped resources as typed facts rather than cleanup booleans', () => {
    const messages = namedBlocks(supervisor, 'message');
    const enums = namedBlocks(supervisor, 'enum');
    expect(messages.get('AttemptProcessReaped')).toMatch(
      /repeated\s+ReleasedResource\s+released_resources\s*=\s*4\s*;/,
    );
    expect(messages.get('ReleasedResource')).toMatch(
      /ReleasedResourceKind\s+kind\s*=\s*1\s*;/,
    );
    expect(messages.get('AttemptProcessReaped')).not.toMatch(/\bbool\b/);
    expect(enums.get('ReleasedResourceKind')).toMatch(/RELEASED_RESOURCE_KIND_DESCENDANTS/);
    expect(enums.get('ReleasedResourceKind')).toMatch(/RELEASED_RESOURCE_KIND_OS_HANDLES/);
    expect(enums.get('ReleasedResourceKind')).toMatch(/RELEASED_RESOURCE_KIND_SCRATCH_STORAGE/);
    expect(enums.get('ReleasedResourceKind')).toMatch(/RELEASED_RESOURCE_KIND_RESOURCE_GROUP/);
  });

  it('keeps domain payloads out of the permanent management channel', () => {
    const declarations = stripComments(supervisor);
    expect(supervisor).toMatch(/import "codestudio\/agent\/v1\/common\.proto";/);
    expect(supervisor).not.toMatch(/import "codestudio\/agent\/v1\/(?:artifact|runtime)\.proto";/);

    for (const forbiddenType of [
      'ArtifactRef',
      'ResolvedAttemptSpec',
      'TaskInput',
      'ProviderBinding',
      'TerminalProposal',
      'UsageBudgetSnapshot',
    ]) {
      expect(declarations, forbiddenType).not.toMatch(new RegExp(`\\b${forbiddenType}\\b`));
    }

    for (const forbiddenField of [
      'prompt',
      'transcript',
      'provider_frame',
      'tool_input',
      'tool_output',
      'artifact_body',
      'live_delta',
    ]) {
      expect(declarations, forbiddenField).not.toMatch(
        new RegExp(`\\b${forbiddenField}\\s*=`),
      );
    }
  });

  it('keeps the normative FrameHeader field numbers stable', () => {
    const header = namedBlocks(runtime, 'message').get('FrameHeader');
    expect(header).toBeDefined();
    expect(Object.fromEntries(fieldTags(header!))).toEqual({
      protocol_version: 1,
      connection_id: 2,
      message_id: 3,
      reply_to_message_id: 4,
      session_id: 5,
      command_id: 6,
      agent_run_id: 7,
      attempt_id: 8,
      executor_owner_id: 9,
      fencing_epoch: 10,
      correlation_id: 11,
      stream_seq: 12,
      sent_at_unix_ms: 13,
      deadline_at_unix_ms: 14,
      payload_sha256: 15,
      operation_id: 16,
      tool_use_id: 17,
      root_agent_run_id: 18,
      owner_agent_run_id: 19,
      parent_agent_run_id: 20,
    });
  });

  it('contains the complete initial handshake, lifecycle, cancel and terminal slice', () => {
    const messages = namedBlocks(runtime, 'message');
    const channels = namedBlocks(runtime, 'enum').get('TransportChannel');
    expect([...messages.keys()]).toEqual(expect.arrayContaining([
      'Frame',
      'FramePayload',
      'AgentHello',
      'HostHello',
      'BindAttemptChannel',
      'AttemptChannelBound',
      'HydrationManifest',
      'HydrationItem',
      'HydrationProgress',
      'HydrationChunk',
      'HydrationComplete',
      'HydrationCommitted',
      'ProviderTurnContext',
      'AgentDefinitionSnapshotV1',
      'CapabilitySetSnapshotV1',
      'ProviderPresetSnapshotV1',
      'ProviderStart',
      'ProviderAccepted',
      'ProviderCancel',
      'ProviderTextDelta',
      'ProviderThinkingDelta',
      'ProviderToolCall',
      'ProviderUsageEvent',
      'ProviderTerminal',
      'EngineEventProposal',
      'EngineEventCommitted',
      'ResolvedAttemptSpec',
      'PrepareAttempt',
      'AttemptPrepared',
      'ActivateAttempt',
      'Heartbeat',
      'CancelAttempt',
      'FenceAttempt',
      'TerminalProposal',
      'TerminalCommitted',
      'Ack',
    ]));
    expect(channels).toMatch(/TRANSPORT_CHANNEL_MANAGEMENT\s*=\s*3\s*;/);
    expect(channels).toMatch(/TRANSPORT_CHANNEL_PULSE\s*=\s*4\s*;/);
    expect(runtime).toContain(
      'SHA-256("codestudio.agent.frame-payload.v1\\0" || encoded_payload)',
    );

    for (const mutation of [
      'PrepareAttempt',
      'AttemptPrepared',
      'ActivateAttempt',
      'BindAttemptChannel',
      'AttemptChannelBound',
      'HydrationManifest',
      'HydrationProgress',
      'HydrationChunk',
      'HydrationComplete',
      'HydrationCommitted',
      'ProviderStart',
      'ProviderAccepted',
      'ProviderCancel',
      'ProviderTextDelta',
      'ProviderThinkingDelta',
      'ProviderToolCall',
      'ProviderUsageEvent',
      'ProviderTerminal',
      'EngineEventProposal',
      'EngineEventCommitted',
      'Heartbeat',
      'CancelAttempt',
      'FenceAttempt',
      'TerminalProposal',
      'TerminalCommitted',
    ]) {
      expect(fieldTags(messages.get(mutation)!).get('identity'), mutation).toBe(1);
    }

    expect(Object.fromEntries(fieldTags(messages.get('Frame')!))).toEqual({
      header: 1,
      channel: 2,
      encoded_payload: 3,
    });
    expect(messages.get('Frame')).not.toContain('oneof');
    expect(Object.fromEntries(fieldTags(messages.get('FramePayload')!))).toEqual({
      agent_hello: 10,
      host_hello: 11,
      prepare_attempt: 12,
      attempt_prepared: 13,
      activate_attempt: 14,
      heartbeat: 15,
      cancel_attempt: 16,
      fence_attempt: 17,
      terminal_proposal: 18,
      terminal_committed: 19,
      ack: 20,
      bind_attempt_channel: 21,
      attempt_channel_bound: 22,
      hydration_manifest: 23,
      hydration_progress: 24,
      hydration_chunk: 25,
      hydration_complete: 26,
      hydration_committed: 27,
      provider_start: 28,
      provider_accepted: 29,
      provider_cancel: 30,
      provider_text_delta: 31,
      provider_thinking_delta: 32,
      provider_tool_call: 33,
      provider_usage: 34,
      provider_terminal: 35,
      engine_event_proposal: 36,
      engine_event_committed: 37,
      capability_prepare: 38,
      capability_update: 39,
      capability_execute: 40,
      capability_execution_result: 41,
      capability_read_batch_execute: 42,
      capability_read_batch_accepted: 43,
      capability_read_batch_result: 44,
      provider_checkpoint: 45,
      provider_checkpoint_committed: 46,
      provider_event_consumed: 47,
      provider_request_chunk: 48,
      provider_request_chunk_accepted: 49,
      provider_request_commit: 50,
    });
    expect(fieldTags(messages.get('ProviderStart')!).get('consumption_ack_required')).toBe(15);
    expect(Object.fromEntries(fieldTags(messages.get('ProviderEventConsumed')!))).toEqual({
      identity: 1, operation_id: 2, event_sequence: 3,
    });
    expect(Object.fromEntries(fieldTags(messages.get('EngineEventProposal')!))).toEqual({
      identity: 1,
      runtime_instance_id: 2,
      record: 3,
      expected_payload_sha256: 4,
    });
    expect(Object.fromEntries(fieldTags(messages.get('EngineEventCommitted')!))).toEqual({
      identity: 1,
      runtime_instance_id: 2,
      local_sequence: 3,
      event_payload_sha256: 4,
      commit_receipt: 5,
    });
    expect(Object.fromEntries(fieldTags(messages.get('BindAttemptChannel')!))).toEqual({
      identity: 1,
      runtime_instance_id: 2,
      channel: 3,
      connection_session_token: 4,
    });
    expect(Object.fromEntries(fieldTags(messages.get('AttemptChannelBound')!))).toEqual({
      identity: 1,
      runtime_instance_id: 2,
      channel: 3,
      effective_limits: 4,
      bound_at_unix_ms: 5,
    });
    expect(Object.fromEntries(fieldTags(messages.get('HydrationManifest')!))).toEqual({
      identity: 1,
      transfer_id: 2,
      items: 3,
      total_payload_bytes: 4,
      max_chunk_bytes: 5,
    });
    expect(Object.fromEntries(fieldTags(messages.get('HydrationItem')!))).toEqual({
      ordinal: 1,
      snapshot: 2,
      artifact: 3,
      byte_length: 4,
    });
    expect(Object.fromEntries(fieldTags(messages.get('HydrationChunk')!))).toEqual({
      identity: 1,
      transfer_id: 2,
      manifest_payload_sha256: 3,
      item_ordinal: 4,
      offset: 5,
      encoded_chunk: 6,
      chunk_sha256: 7,
      end_of_item: 8,
    });
    expect(Object.fromEntries(fieldTags(messages.get('HydrationProgress')!))).toEqual({
      identity: 1,
      runtime_instance_id: 2,
      transfer_id: 3,
      manifest_payload_sha256: 4,
      next_item_ordinal: 5,
      next_offset: 6,
      accepted_payload_bytes: 7,
      max_next_chunk_bytes: 8,
    });
    expect(Object.fromEntries(fieldTags(messages.get('HydrationComplete')!))).toEqual({
      identity: 1,
      transfer_id: 2,
      manifest_payload_sha256: 3,
      item_count: 4,
      total_payload_bytes: 5,
    });
    expect(Object.fromEntries(fieldTags(messages.get('HydrationCommitted')!))).toEqual({
      identity: 1,
      runtime_instance_id: 2,
      transfer_id: 3,
      manifest_payload_sha256: 4,
      item_count: 5,
      total_payload_bytes: 6,
    });
    expect(Object.fromEntries(fieldTags(messages.get('ProviderTurnContext')!))).toEqual({
      system: 1,
      messages: 2,
      tools: 3,
      thinking: 4,
      reasoning_effort: 5,
      thinking_budget_tokens: 6,
      previous_response_id: 7,
      previous_response_message_count: 8,
      prepared_user_context: 9,
      prepared_boundary_context: 10,
    });
    expect(Object.fromEntries(fieldTags(messages.get('ProviderRequestChunk')!))).toEqual({
      identity: 1, runtime_instance_id: 2, operation_id: 3, total_bytes: 4,
      request_sha256: 5, chunk_offset: 6, encoded_chunk: 7, checkpoint_only: 8,
    });
    expect(Object.fromEntries(fieldTags(messages.get('ProviderRequestCommit')!))).toEqual({
      identity: 1, runtime_instance_id: 2, operation_id: 3, total_bytes: 4,
      request_sha256: 5, checkpoint_only: 6,
    });
    expect(Object.fromEntries(fieldTags(messages.get('ProviderPreparedUserContextV1')!))).toEqual({
      message_index: 1, selected_skill_ids: 2, content_utf8: 3,
    });
    expect(Object.fromEntries(fieldTags(messages.get('ProviderToolDescriptor')!))).toEqual({
      capability_name: 1,
      description: 2,
      encoded_json_schema: 3,
      schema_sha256: 4,
      capability_id: 5,
      capability_version: 6,
      execution_class: 7,
      mutates: 8,
      parallel_safe: 9,
      read_only: 10,
    });
    expect(Object.fromEntries(
      fieldTags(messages.get('AgentDefinitionSnapshotV1')!),
    )).toEqual({
      schema_version: 1,
      agent_definition_id: 2,
      system_prompt_utf8: 3,
    });
    expect(Object.fromEntries(
      fieldTags(messages.get('CapabilitySetSnapshotV1')!),
    )).toEqual({
      schema_version: 1,
      tools: 2,
    });
    expect(Object.fromEntries(
      fieldTags(messages.get('ProviderPresetSnapshotV1')!),
    )).toEqual({
      schema_version: 1,
      effective_preset: 2,
      thinking: 3,
      thinking_budget_tokens: 4,
    });

    expect(Object.fromEntries(fieldTags(messages.get('PrepareAttempt')!))).toEqual({
      identity: 1,
      encoded_spec: 2,
      expected_spec_sha256: 3,
      expected_snapshots: 4,
      idempotency_key: 5,
      spec_schema_version: 6,
    });
    expect(messages.get('PrepareAttempt')).toContain('bytes encoded_spec = 2;');
    expect(fieldTags(messages.get('ActivateAttempt')!).get('idempotency_key')).toBe(7);
    expect(Object.fromEntries(fieldTags(messages.get('CancelAttempt')!))).toEqual({
      identity: 1,
      reason: 2,
      reason_code: 3,
      grace_deadline_at_unix_ms: 4,
      idempotency_key: 5,
    });
    expect(Object.fromEntries(fieldTags(messages.get('FenceAttempt')!))).toEqual({
      identity: 1,
      replacement_fencing_epoch: 2,
      reason_code: 3,
      fenced_at_unix_ms: 4,
      idempotency_key: 5,
    });
  });

  it('defines a pre-dispatch capability decision without granting implicit effects', () => {
    const messages = namedBlocks(capability, 'message');
    const executionClasses = namedBlocks(capability, 'enum')
      .get('CapabilityExecutionClass');
    expect(executionClasses).toMatch(/CAPABILITY_EXECUTION_CLASS_NATIVE_READ\s*=\s*1\s*;/);
    expect(executionClasses).toMatch(/CAPABILITY_EXECUTION_CLASS_HOST_CAPABILITY\s*=\s*4\s*;/);
    expect(Object.fromEntries(fieldTags(messages.get('CapabilityPrepare')!))).toEqual({
      identity: 1,
      runtime_instance_id: 2,
      operation_id: 3,
      provider_operation_id: 4,
      tool_use_id: 5,
      capability_id: 6,
      capability_version: 7,
      execution_class: 8,
      mutates: 9,
      encoded_json_input: 10,
      input_sha256: 11,
      capability_set_sha256: 12,
      idempotency_key: 13,
      deadline_at_unix_ms: 14,
    });
    expect(Object.fromEntries(fieldTags(messages.get('CapabilityUpdate')!))).toEqual({
      identity: 1,
      runtime_instance_id: 2,
      operation_id: 3,
      tool_use_id: 4,
      rejected: 10,
      approval_required: 11,
      accepted: 12,
    });
    expect(Object.fromEntries(fieldTags(messages.get('SealedExecutionGrant')!))).toEqual({
      grant_id: 1,
      decision_id: 2,
      capability_id: 3,
      capability_version: 4,
      operation_id: 5,
      tool_use_id: 6,
      effective_input_sha256: 7,
      execution_class: 8,
      mutates: 9,
      environment_id: 10,
      environment_version: 11,
      workspace_lease_id: 12,
      workspace_lease_version: 13,
      workspace_fencing_epoch: 14,
      resource_binding_id: 15,
      constraints_sha256: 16,
      policy_version: 17,
      nonce: 18,
      issued_at_unix_ms: 19,
      expires_at_unix_ms: 20,
      native_filesystem_read: 21,
    });
    expect(Object.fromEntries(
      fieldTags(messages.get('NativeFilesystemReadBinding')!),
    )).toEqual({
      canonical_root_path: 1,
      max_read_bytes: 2,
      max_output_bytes: 3,
      require_utf8: 4,
    });
  });

  it('defines a path-free fenced session-store bridge contract', () => {
    const messages = namedBlocks(sessionStore, 'message');
    expect(Object.fromEntries(fieldTags(messages.get('EngineEventRecordV1')!))).toEqual({
      schema_version: 1,
      identity: 2,
      runtime_instance_id: 3,
      local_sequence: 4,
      provider_started: 10,
      provider_delta: 11,
      provider_usage: 12,
      provider_completed: 13,
      capability_boundary: 14,
      terminal: 15,
      capability_dispatch_started: 16,
      capability_terminal: 17,
      content: 18,
      capability_refused: 19,
    });
    expect(Object.fromEntries(
      fieldTags(messages.get('EngineProviderDeltaRecordV1')!),
    )).toEqual({
      operation_id: 1,
      utf8_bytes: 2,
      content_sha256: 3,
      thinking: 4,
    });
    expect(Object.fromEntries(fieldTags(messages.get('EngineTerminalRecordV1')!))).toEqual({
      classification: 1,
      reason_code: 2,
      usage: 3,
    });
    expect(Object.fromEntries(fieldTags(messages.get('SessionStoreRequest')!))).toEqual({
      open_session_writer: 10,
      commit_session_record: 11,
      publish_session_projection: 12,
      query_session_state: 13,
      transfer_session_storage_generation: 14,
      archive_session: 15,
      close_session_writer: 16,
      read_committed_session_payload: 17,
      list_committed_session_records: 18,
      open_session_reader: 19,
      close_session_reader: 20,
      acquire_storage_root_lock: 21,
      release_storage_root_lock: 22,
      inspect_supervisor_lifecycle_evidence: 23,
    });
    expect(Object.fromEntries(fieldTags(messages.get('CommitSessionRecordReceipt')!))).toEqual({
      session_id: 1,
      operation_id: 2,
      authority: 3,
      global_sequence: 4,
      kind: 5,
      durability: 6,
      previous_commit_sha256: 7,
      payload_sha256: 8,
      commit_sha256: 9,
      payload_bytes: 10,
      replay: 11,
    });
    expect(Object.fromEntries(fieldTags(messages.get('TransferSessionStorageGeneration')!)))
      .toEqual({
        root_id: 1,
        session_id: 2,
        source_generation: 3,
        target_generation: 4,
        expected_source_lease_epoch: 5,
        next_authority: 6,
        verified_manifest_sha256: 7,
        idempotency_key: 8,
      });
    expect(Object.fromEntries(fieldTags(messages.get('ReadCommittedSessionPayload')!))).toEqual({
      writer_handle: 1,
      authority: 2,
      operation_id: 3,
      kind: 4,
      expected_payload_sha256: 5,
      expected_payload_bytes: 6,
      reader_handle: 7,
    });
    expect(Object.fromEntries(fieldTags(messages.get('CommittedSessionPayload')!))).toEqual({
      commit_receipt: 1,
      encoded_payload: 2,
    });
    expect(Object.fromEntries(
      fieldTags(messages.get('ListCommittedSessionRecords')!),
    )).toEqual({
      writer_handle: 1,
      authority: 2,
      after_global_sequence: 3,
      max_records: 4,
      snapshot_id: 5,
      reader_handle: 6,
    });
    expect(Object.fromEntries(
      fieldTags(messages.get('CommittedSessionRecordPage')!),
    )).toEqual({
      session_id: 1,
      records: 2,
      next_global_sequence: 3,
      complete: 4,
      snapshot_id: 5,
    });

    const declarations = stripComments(sessionStore);
    expect(declarations).not.toMatch(/\b(?:path|directory|filename|credential|token)\s*=/);
    expect(messages.get('SessionStoreRequestFrame')).not.toContain('oneof');
    expect(messages.get('SessionStoreResponseFrame')).not.toContain('oneof');
    expect(sessionStore).toContain('opaque native bridge owner');
  });

  it('keeps the runner pulse private, bounded and free of domain payloads', () => {
    const messages = namedBlocks(supervisor, 'message');
    expect(Object.fromEntries(fieldTags(messages.get('RunnerPulse')!))).toEqual({
      attempt_id: 1,
      runtime_instance_id: 2,
      fencing_epoch: 3,
      phase: 4,
      monotonic_counter: 5,
      last_progress_seq: 6,
      resources: 7,
    });
    expect(Object.fromEntries(fieldTags(messages.get('PulseFrame')!))).toEqual({
      encoded_pulse: 1,
      authentication_tag: 2,
    });
    expect(messages.get('PulseFrame')).not.toContain('oneof');
    expect(messages.get('ManagementPayload')).not.toContain('runner_pulse');
  });

  it('preserves attempt authority and physical provenance at the wire boundary', () => {
    const commonMessages = namedBlocks(common, 'message');
    expect(Object.fromEntries(fieldTags(commonMessages.get('AttemptIdentity')!))).toEqual({
      session_id: 1,
      command_id: 2,
      agent_run_id: 3,
      attempt_id: 4,
      executor_owner_id: 5,
      fencing_epoch: 6,
      correlation_id: 7,
      root_agent_run_id: 8,
      owner_agent_run_id: 9,
      parent_agent_run_id: 10,
    });

    const provenance = fieldTags(commonMessages.get('RuntimeProvenance')!);
    expect(provenance.get('binary_sha256')).toBe(3);
    expect(provenance.get('runtime_instance_id')).toBe(4);
    expect(provenance.get('pid')).toBe(5);
  });

  it('keeps liveness and terminal durability data explicit', () => {
    const messages = namedBlocks(runtime, 'message');
    expect(Object.fromEntries(fieldTags(messages.get('Heartbeat')!))).toEqual({
      identity: 1,
      runtime_instance_id: 2,
      last_alive_at_unix_ms: 3,
      last_progress_at_unix_ms: 4,
      last_event_seq: 5,
      active_provider_operation_ids: 6,
      active_capability_operation_ids: 7,
      active_child_attempt_ids: 8,
      phase: 9,
      resources: 10,
    });

    const terminal = fieldTags(messages.get('TerminalProposal')!);
    expect(terminal.get('transcript')).toBe(6);
    expect(terminal.get('final_usage')).toBe(9);
    expect(terminal.get('terminal_payload_sha256')).toBe(11);
    expect(terminal.get('final_budget')).toBe(12);

    const committed = fieldTags(messages.get('TerminalCommitted')!);
    expect(committed.get('terminal_proposal_message_id')).toBe(2);
    expect(committed.get('terminal_payload_sha256')).toBe(3);
    expect(committed.get('committed_at_unix_ms')).toBe(6);
  });

  it('carries every mandatory per-attempt resource limit on the wire', () => {
    const messages = namedBlocks(common, 'message');
    expect(Object.fromEntries(fieldTags(messages.get('ResourceBudget')!))).toEqual({
      soft_memory_bytes: 1,
      hard_memory_bytes: 2,
      cpu_time_ms: 3,
      max_wall_ms: 4,
      max_processes: 5,
      max_threads: 6,
      max_open_handles: 7,
      max_hot_transcript_bytes: 8,
      max_ipc_frames: 9,
      max_ipc_bytes: 10,
      max_spool_bytes: 11,
      max_artifact_bytes: 12,
      max_concurrent_tools: 13,
      max_blocking_tasks: 14,
      cancel_grace_ms: 15,
    });
  });

  it('reports containment level and applied limits instead of capability claims only', () => {
    const messages = namedBlocks(common, 'message');
    expect(Object.fromEntries(fieldTags(messages.get('ContainmentReport')!))).toEqual({
      level: 1,
      enforced_limits: 2,
      unsupported_limits: 3,
      capabilities: 4,
    });

    const runtimeMessages = namedBlocks(runtime, 'message');
    expect(runtimeMessages.get('AttemptPrepared')).toMatch(
      /ContainmentReport\s+effective_containment\s*=\s*7\s*;/,
    );
  });

  it('uses safe numeric representations and fail-closed enum defaults', () => {
    for (const source of sources) {
      const declarations = stripComments(source);
      expect(declarations).not.toMatch(/\b(?:float|double)\b/);
      expect(declarations).not.toContain('google.protobuf.Struct');

      for (const [name, body] of namedBlocks(source, 'enum')) {
        const firstValue = body.match(/^\s*(\w+)\s*=\s*(\d+)\s*;/m);
        expect(firstValue, `enum ${name} must declare an UNSPECIFIED zero value`).not.toBeNull();
        expect(firstValue![1], `enum ${name}`).toMatch(/_UNSPECIFIED$/);
        expect(Number(firstValue![2]), `enum ${name}`).toBe(0);
      }
    }
  });

  it('freezes the verified resume frontier fields', () => {
    expect(Object.fromEntries(fieldTags(namedBlocks(runtime, 'message').get('ProviderResumeContextV1')!))).toEqual({
      schema_version: 1, session_id: 2, agent_run_id: 3, source_attempt_id: 4,
      provider_binding: 5, context: 6, unresolved_capability_operation_ids: 7,
    });
    expect(Object.fromEntries(fieldTags(namedBlocks(runtime, 'message').get('ProviderFrontierRecordV1')!))).toEqual({
      schema_version: 1, operation_id: 2, frontier: 3, base_operation_id: 4,
      retained_message_count: 5, base_frontier_sha256: 6, frontier_sha256: 7,
    });
  });

  it('does not reuse a field number inside any message', () => {
    for (const source of sources) {
      for (const [name, body] of namedBlocks(source, 'message')) {
        const tags = [...fieldTags(body).values()];
        expect(new Set(tags).size, `duplicate field number in ${name}`).toBe(tags.length);
      }
    }
  });

  it('configures file-level Protobuf breaking-change protection', () => {
    const buf = readFileSync(resolve(packageRoot, 'buf.yaml'), 'utf8');
    expect(buf).toMatch(/version:\s*v2/);
    expect(buf).toMatch(/path:\s*proto/);
    expect(buf).toMatch(/breaking:[\s\S]*-\s*FILE/);
  });
});
