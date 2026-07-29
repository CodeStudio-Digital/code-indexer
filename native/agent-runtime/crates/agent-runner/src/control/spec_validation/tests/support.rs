use agent_protocol::generated::v1 as wire;

use super::super::{SpecValidationContext, ValidatedSpec, validate_resolved_attempt_spec_v1};

pub(super) const NOW: i64 = 1_000;
pub(super) const SPEC_DEADLINE: i64 = 9_000;
pub(super) const LAUNCH_DEADLINE: i64 = 10_000;

pub(super) fn identity() -> wire::AttemptIdentity {
    wire::AttemptIdentity {
        session_id: "11111111-1111-4111-8111-111111111111".to_owned(),
        command_id: "22222222-2222-4222-8222-222222222222".to_owned(),
        agent_run_id: "33333333-3333-4333-8333-333333333333".to_owned(),
        attempt_id: "44444444-4444-4444-8444-444444444444".to_owned(),
        executor_owner_id: "owner-1".to_owned(),
        fencing_epoch: 7,
        correlation_id: "55555555-5555-4555-8555-555555555555".to_owned(),
        root_agent_run_id: "33333333-3333-4333-8333-333333333333".to_owned(),
        owner_agent_run_id: None,
        parent_agent_run_id: None,
    }
}

pub(super) const fn resource_budget() -> wire::ResourceBudget {
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

pub(super) fn snapshot(name: &str) -> wire::SnapshotRef {
    wire::SnapshotRef {
        r#ref: format!("snapshot:{name}"),
        version: 1,
        content_sha256: vec![7; 32],
        origin: "host".to_owned(),
        schema_id: format!("codestudio.{name}.v1"),
        schema_version: 1,
    }
}

pub(super) fn artifact(name: &str) -> wire::ArtifactRef {
    wire::ArtifactRef {
        artifact_id: format!("artifact:{name}"),
        kind: "fixture".to_owned(),
        content_sha256: vec![9; 32],
        media_type: "application/octet-stream".to_owned(),
        byte_length: 42,
        compression: wire::ArtifactCompression::None as i32,
        privacy_class: wire::ArtifactPrivacyClass::Internal as i32,
        redaction_policy_version: "redaction-v1".to_owned(),
        owner_session_id: "11111111-1111-4111-8111-111111111111".to_owned(),
    }
}

pub(super) fn valid_spec() -> wire::ResolvedAttemptSpec {
    wire::ResolvedAttemptSpec {
        schema_version: 1,
        spec_version: 4,
        identity: Some(identity()),
        ordinal: 1,
        trigger: wire::AttemptTrigger::Initial as i32,
        spawn_depth: 0,
        role: "coder".to_owned(),
        agent_definition_id: "native-coder".to_owned(),
        task: Some(wire::TaskInput {
            body: Some(wire::task_input::Body::InlineUtf8(
                "Implement the requested change".to_owned(),
            )),
            attachments: Vec::new(),
        }),
        provider_binding: Some(wire::ProviderBinding {
            requested_provider: Some("openai".to_owned()),
            requested_model: Some("gpt-5".to_owned()),
            effective_provider: "openai".to_owned(),
            effective_model: "gpt-5".to_owned(),
            ..Default::default()
        }),
        downgrade_reasons: Vec::new(),
        wait_mode: wire::AgentRunWaitMode::Foreground as i32,
        run_tree_budget: Some(wire::AgentRunBudget {
            max_turns: Some(20),
            max_wall_ms: Some(20_000),
            max_input_tokens: Some(100_000),
            max_output_tokens: Some(50_000),
            max_tool_calls: Some(100),
            max_agents: Some(8),
            max_depth: Some(4),
            max_cost_micros: Some(10_000_000),
            cost_currency: Some("USD".to_owned()),
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
        deadline_at_unix_ms: SPEC_DEADLINE,
        agent_definition_snapshot: Some(snapshot("agent-definition")),
    }
}

pub(super) fn validate(
    spec: wire::ResolvedAttemptSpec,
) -> Result<ValidatedSpec, super::super::SpecValidationError> {
    validate_with_identity(spec, &identity())
}

pub(super) fn validate_with_spec_identity(
    spec: wire::ResolvedAttemptSpec,
) -> Result<ValidatedSpec, super::super::SpecValidationError> {
    let expected_identity = spec.identity.clone().expect("fixture identity");
    validate_with_identity(spec, &expected_identity)
}

fn validate_with_identity(
    spec: wire::ResolvedAttemptSpec,
    expected_identity: &wire::AttemptIdentity,
) -> Result<ValidatedSpec, super::super::SpecValidationError> {
    let launch_budget = resource_budget();
    validate_resolved_attempt_spec_v1(
        spec,
        SpecValidationContext {
            expected_identity,
            launch_resource_budget: &launch_budget,
            launch_hard_deadline_at_unix_ms: LAUNCH_DEADLINE,
            observed_at_unix_ms: NOW,
        },
    )
}
