use agent_protocol::frame::CONTROL_FRAME_MAX_BYTES;
use agent_protocol::generated::v1 as wire;

use super::identity;

pub(super) fn host_hello(
    connection_id: &str,
    contract_version: &str,
    connection_token: &[u8],
) -> wire::HostHello {
    wire::HostHello {
        selected_protocol: Some(wire::ProtocolVersion { major: 1, minor: 1 }),
        connection_id: connection_id.into(),
        contract_version: contract_version.into(),
        contract_schema_version: 1,
        heartbeat_interval_ms: 1_000,
        heartbeat_timeout_ms: 3_000,
        frame_limits: Some(wire::FrameLimits {
            max_frame_bytes: CONTROL_FRAME_MAX_BYTES as u64,
            max_chunk_bytes: 64 * 1024,
            max_in_flight_frames: 4,
            max_in_flight_bytes: (CONTROL_FRAME_MAX_BYTES * 4) as u64,
            read_timeout_ms: 1_000,
            write_timeout_ms: 1_000,
            transport_crc32c: false,
        }),
        connection_session_token: connection_token.to_vec(),
        allowed_feature_bits: 0,
        required_feature_bits: 0,
    }
}

pub(super) fn valid_spec(deadline_at_unix_ms: i64) -> wire::ResolvedAttemptSpec {
    wire::ResolvedAttemptSpec {
        schema_version: 1,
        spec_version: 1,
        identity: Some(identity()),
        ordinal: 1,
        trigger: wire::AttemptTrigger::Initial as i32,
        spawn_depth: 0,
        role: "performance-probe".into(),
        agent_definition_id: "native-performance-probe".into(),
        task: Some(wire::TaskInput {
            body: Some(wire::task_input::Body::InlineUtf8("probe".into())),
            attachments: Vec::new(),
        }),
        provider_binding: Some(wire::ProviderBinding {
            effective_provider: "none".into(),
            effective_model: "none".into(),
            ..wire::ProviderBinding::default()
        }),
        downgrade_reasons: Vec::new(),
        wait_mode: wire::AgentRunWaitMode::Foreground as i32,
        run_tree_budget: Some(wire::AgentRunBudget {
            max_turns: Some(1),
            max_wall_ms: Some(2_000),
            max_input_tokens: Some(1),
            max_output_tokens: Some(1),
            max_tool_calls: Some(1),
            max_agents: Some(1),
            max_depth: Some(1),
            max_cost_micros: Some(1),
            cost_currency: Some("USD".into()),
        }),
        verifier_policy_snapshot: Some(snapshot("verifier")),
        capability_set_snapshot: Some(snapshot("capabilities")),
        environment_snapshot: Some(snapshot("environment")),
        workspace_lease_snapshot: Some(snapshot("workspace-lease")),
        workspace_lease_fencing_epoch: 7,
        policy_snapshot: Some(snapshot("policy")),
        preset_snapshot: Some(snapshot("preset")),
        checkpoint_input: None,
        transcript_input: None,
        resource_budget: Some(resource_budget()),
        deadline_at_unix_ms,
        agent_definition_snapshot: Some(snapshot("agent-definition")),
        codex_app_server_process_snapshot: None,
    }
}

pub(super) fn required_snapshots(spec: &wire::ResolvedAttemptSpec) -> Vec<wire::SnapshotRef> {
    [
        spec.verifier_policy_snapshot.clone(),
        spec.capability_set_snapshot.clone(),
        spec.environment_snapshot.clone(),
        spec.workspace_lease_snapshot.clone(),
        spec.policy_snapshot.clone(),
        spec.preset_snapshot.clone(),
        spec.agent_definition_snapshot.clone(),
    ]
    .into_iter()
    .flatten()
    .collect()
}

pub(in crate::performance) const fn resource_budget() -> wire::ResourceBudget {
    wire::ResourceBudget {
        soft_memory_bytes: 32 * 1024 * 1024,
        hard_memory_bytes: 64 * 1024 * 1024,
        cpu_time_ms: 1_000,
        max_wall_ms: 2_000,
        max_processes: 4,
        max_threads: 8,
        max_open_handles: 64,
        max_hot_transcript_bytes: 16 * 1024,
        max_ipc_frames: 128,
        max_ipc_bytes: 1024 * 1024,
        max_spool_bytes: 64 * 1024,
        max_artifact_bytes: 32 * 1024,
        max_concurrent_tools: 2,
        max_blocking_tasks: 2,
        cancel_grace_ms: 100,
    }
}

pub(in crate::performance) fn containment_report() -> wire::ContainmentReport {
    wire::ContainmentReport {
        level: wire::ContainmentLevel::HardAggregate as i32,
        enforced_limits: vec![
            wire::ResourceLimitKind::Memory as i32,
            wire::ResourceLimitKind::CpuTime as i32,
            wire::ResourceLimitKind::Processes as i32,
        ],
        unsupported_limits: vec![
            wire::ResourceLimitKind::WallTime as i32,
            wire::ResourceLimitKind::Threads as i32,
            wire::ResourceLimitKind::OpenHandles as i32,
            wire::ResourceLimitKind::ScratchBytes as i32,
        ],
        capabilities: Some(wire::ContainmentCapabilities {
            process_tree: true,
            memory_limit: true,
            cpu_limit: true,
            process_count_limit: true,
            open_file_limit: false,
            filesystem_quota: false,
            network_policy: false,
        }),
    }
}

fn snapshot(name: &str) -> wire::SnapshotRef {
    wire::SnapshotRef {
        r#ref: format!("snapshot:{name}"),
        version: 1,
        content_sha256: vec![7; 32],
        origin: "performance-harness".into(),
        schema_id: format!("codestudio.performance.{name}.v1"),
        schema_version: 1,
    }
}
