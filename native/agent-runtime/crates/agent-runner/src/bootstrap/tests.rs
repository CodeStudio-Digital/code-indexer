use std::cell::Cell;
use std::io::Cursor;
use std::sync::atomic::{AtomicU64, Ordering};

use agent_platform::ipc::{EndpointBufferCapacity, ExpectedLocalPeer};
use agent_platform::windows::ipc::WindowsProtectedEndpoint;
use agent_protocol::frame::{CONTROL_FRAME_MAX_BYTES, DATA_FRAME_MAX_BYTES, PULSE_FRAME_MAX_BYTES};
use agent_protocol::generated::v1 as wire;
use agent_protocol::runner_bootstrap::{
    ShapeValidatedRunnerLaunchHandoff, decode_runner_launch_handoff,
};
use prost::Message;

use super::physical::{RunnerPhysicalBootstrapError, materialize_windows_bootstrap_with};
use super::{
    PreparedMaterializedRunnerBootstrap, RunnerMaterializationError,
    prepare_materialized_windows_bootstrap,
};
use crate::control::{LaunchContextError, RunnerLaunchContext};

const NOW: i64 = 1_000;
const DEADLINE: i64 = 10_000;
const LAUNCH_NONCE: &[u8] = &[7; 32];
const PIPE_PREFIX: &str = r"\\.\pipe\codestudio-agent-v1-";
static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);

#[test]
fn invalid_pid_deadline_and_mode_cannot_produce_ready() {
    let mut wrong_pid = windows_handoff();
    wrong_pid.runner_process_id = distinct_pid(&[
        std::process::id(),
        wrong_pid
            .expected_host_peer
            .as_ref()
            .expect("host")
            .process_id,
        wrong_pid
            .expected_supervisor_peer
            .as_ref()
            .expect("supervisor")
            .process_id,
    ]);
    wrong_pid
        .runtime_provenance
        .as_mut()
        .expect("runtime provenance")
        .pid = wrong_pid.runner_process_id;
    assert!(matches!(
        prepare_materialized_windows_bootstrap(shape(&wrong_pid), NOW),
        Err(RunnerMaterializationError::RunnerProcessMismatch { .. })
    ));

    let deadline = windows_handoff();
    assert!(matches!(
        prepare_materialized_windows_bootstrap(shape(&deadline), DEADLINE),
        Err(RunnerMaterializationError::DeadlineExpired { .. })
    ));

    let unix = unix_handoff();
    assert!(matches!(
        prepare_materialized_windows_bootstrap(shape(&unix), NOW),
        Err(RunnerMaterializationError::WrongProvisioning)
    ));
}

#[test]
fn endpoint_verifier_from_same_metadata_but_another_handoff_is_rejected() {
    let first = windows_handoff();
    let mut second = first.clone();
    second.endpoints[0].connection_token = vec![99; 32];
    let first = shape(&first);
    let mut second = shape(&second);
    let foreign = second
        .take_endpoint_token_verifier(wire::AttemptEndpointKind::Control)
        .expect("foreign control verifier");

    assert!(matches!(
        RunnerLaunchContext::from_validated_handoff(&first, foreign),
        Err(LaunchContextError::EndpointAuthorityMismatch)
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn materialized_transition_keeps_nonce_and_context_in_one_redacted_owner() {
    tokio::task::yield_now().await;
    let handoff = windows_handoff();
    let materialized = prepare_materialized_windows_bootstrap(shape(&handoff), NOW)
        .expect("materialized endpoints")
        .commit_ready_with(|_| Ok::<_, ()>(()))
        .expect("ready commit");

    let prepared = materialized
        .prepare_control_launch()
        .expect("control launch transition");
    let debug = format!("{prepared:?}");
    assert!(debug.contains("[OWNED; REDACTED]"));
    assert!(!debug.contains("[7, 7, 7"));
    assert!(!debug.contains("[1, 1, 1"));
    let hello = prepared
        .protected_agent_hello_draft()
        .expect("protected Hello draft");
    assert!(hello.launch_nonce.is_empty());
    assert_eq!(hello.contract_version, "1.0.0");
    assert_eq!(
        hello.provenance, handoff.runtime_provenance,
        "runner provenance must come from the protected handoff"
    );
    assert_eq!(
        hello.containment,
        handoff
            .effective_containment
            .as_ref()
            .and_then(|report| report.capabilities)
    );

    let (pending, mut remaining, control, data, pulse) = prepared.into_accept_parts();
    assert!(remaining.take_launch_nonce().is_none());
    assert!(
        remaining
            .take_endpoint_token_verifier(wire::AttemptEndpointKind::Control)
            .is_err()
    );
    drop((pending, remaining, control, data, pulse));
}

#[test]
fn physical_bootstrap_error_rendering_redacts_creator_pids() {
    let error = RunnerPhysicalBootstrapError::CreatorProcessMismatch {
        expected: 4_000_000_001,
        actual: 4_000_000_002,
    };
    let debug = format!("{error:?}");
    let display = error.to_string();

    assert!(debug.contains("supervisor_authority"));
    assert!(debug.contains("[REDACTED]"));
    assert!(!debug.contains("4000000001"));
    assert!(!debug.contains("4000000002"));
    assert!(!display.contains("4000000001"));
    assert!(!display.contains("4000000002"));
}

#[tokio::test(flavor = "current_thread")]
async fn committed_ready_retains_secrets_and_all_pipes_have_the_runner_creator_pid() {
    tokio::task::yield_now().await;
    let handoff = windows_handoff();
    let addresses = endpoint_addresses(&handoff);
    let creator_process_id = handoff
        .expected_supervisor_peer
        .as_ref()
        .expect("supervisor")
        .process_id;
    let mut encoded_handoff = Vec::new();
    handoff
        .encode_length_delimited(&mut encoded_handoff)
        .expect("bounded physical handoff");
    let mut encoded_ready = Vec::new();
    let materialized = materialize_windows_bootstrap_with(
        creator_process_id,
        Cursor::new(encoded_handoff),
        &mut encoded_ready,
        || Ok(NOW),
        prepare_materialized_windows_bootstrap,
    )
    .expect("physical bootstrap composition");

    let ready = wire::RunnerEndpointsReady::decode_length_delimited(encoded_ready.as_slice())
        .expect("bounded physical Ready frame");
    assert_eq!(ready.runner_process_id, std::process::id());
    assert_eq!(ready.endpoints.len(), 3);
    assert!(materialized.handoff.launch_nonce_matches(LAUNCH_NONCE));

    let expected = ExpectedLocalPeer::new(std::process::id()).expect("runner PID");
    for address in addresses {
        let client = WindowsProtectedEndpoint::connect_expected_address(&address, expected)
            .expect("pipe created by this runner");
        assert_eq!(client.peer().process_id(), std::process::id());
    }
}

#[tokio::test(flavor = "current_thread")]
async fn creator_mismatch_rejects_before_clock_or_endpoint_materialization() {
    tokio::task::yield_now().await;
    let handoff = windows_handoff();
    let addresses = endpoint_addresses(&handoff);
    let expected_creator = handoff
        .expected_supervisor_peer
        .as_ref()
        .expect("supervisor")
        .process_id;
    let actual_creator = distinct_pid(&[expected_creator]);
    let mut encoded_handoff = Vec::new();
    handoff
        .encode_length_delimited(&mut encoded_handoff)
        .expect("bounded physical handoff");
    let observed = Cell::new(false);
    let materializer_called = Cell::new(false);
    let mut encoded_ready = Vec::new();

    let error = materialize_windows_bootstrap_with(
        actual_creator,
        Cursor::new(encoded_handoff),
        &mut encoded_ready,
        || {
            observed.set(true);
            Ok(NOW)
        },
        |_, _| -> Result<PreparedMaterializedRunnerBootstrap, RunnerMaterializationError> {
            materializer_called.set(true);
            panic!("creator mismatch must precede endpoint materialization")
        },
    )
    .expect_err("a different physical creator cannot authorize the handoff");

    assert!(matches!(
        error,
        RunnerPhysicalBootstrapError::CreatorProcessMismatch {
            expected,
            actual
        } if expected == expected_creator && actual == actual_creator
    ));
    assert!(!observed.get());
    assert!(!materializer_called.get());
    assert!(encoded_ready.is_empty());
    for address in addresses {
        drop(
            WindowsProtectedEndpoint::bind_expected_address(&address, capacity_for(&address))
                .expect("creator mismatch performed zero endpoint binds"),
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn ready_write_failure_drops_listeners_and_allows_exact_rebind() {
    tokio::task::yield_now().await;
    let handoff = windows_handoff();
    let addresses = endpoint_addresses(&handoff);
    let prepared = prepare_materialized_windows_bootstrap(shape(&handoff), NOW)
        .expect("materialized endpoints");
    let error = prepared
        .commit_ready_with(|ready| {
            assert!(!ready.is_empty());
            Err::<(), _>("injected write failure")
        })
        .expect_err("failed Ready cannot produce a materialized owner");
    assert_eq!(error, "injected write failure");

    for address in addresses {
        drop(
            WindowsProtectedEndpoint::bind_expected_address(&address, capacity_for(&address))
                .expect("failed commit released exact pipe name"),
        );
    }
}

fn shape(handoff: &wire::RunnerLaunchHandoff) -> ShapeValidatedRunnerLaunchHandoff {
    decode_runner_launch_handoff(handoff.encode_to_vec()).expect("shape-valid handoff")
}

fn windows_handoff() -> wire::RunnerLaunchHandoff {
    let fixture = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
    let (host_pid, supervisor_pid) = peer_pids();
    wire::RunnerLaunchHandoff {
        schema_version: 1,
        identity: Some(identity()),
        runtime_instance_id: format!("runtime:{fixture}"),
        runner_process_id: std::process::id(),
        endpoints: endpoints(fixture, false),
        launch_nonce: LAUNCH_NONCE.to_vec(),
        hard_deadline_at_unix_ms: DEADLINE,
        reserved_resource_budget: Some(budget()),
        effective_containment: Some(containment()),
        launch_management_payload_sha256: vec![8; 32],
        expected_host_peer: Some(wire::RunnerExpectedLocalPeer {
            process_id: host_pid,
            unix_user_id: None,
        }),
        expected_supervisor_peer: Some(wire::RunnerExpectedLocalPeer {
            process_id: supervisor_pid,
            unix_user_id: None,
        }),
        activation_authority_seal: Some(wire::ActivationAuthoritySeal {
            agent_run_version: 8,
            attempt_version: 5,
            activation_nonce_sha256: vec![7; 32],
        }),
        runtime_provenance: Some(wire::RuntimeProvenance {
            build_id: "runner-build".into(),
            source_commit: "runner-commit".into(),
            binary_sha256: vec![8; 32],
            runtime_instance_id: format!("runtime:{fixture}"),
            pid: std::process::id(),
            operating_system: "windows".into(),
            architecture: "x86_64".into(),
        }),
    }
}

fn unix_handoff() -> wire::RunnerLaunchHandoff {
    let mut handoff = windows_handoff();
    handoff
        .expected_host_peer
        .as_mut()
        .expect("host")
        .unix_user_id = Some(1_000);
    handoff
        .expected_supervisor_peer
        .as_mut()
        .expect("supervisor")
        .unix_user_id = Some(1_000);
    for (endpoint, slot) in handoff.endpoints.iter_mut().zip([
        wire::RunnerListenerSlot::Control,
        wire::RunnerListenerSlot::Data,
        wire::RunnerListenerSlot::RunnerPulse,
    ]) {
        endpoint.provisioning = wire::RunnerEndpointProvisioning::UnixReceiveBoundSocket as i32;
        endpoint.listener_slot = slot as i32;
        endpoint.address = format!("/private/{}.sock", endpoint.endpoint_id);
    }
    handoff
}

fn endpoints(fixture: u64, unix: bool) -> Vec<wire::RunnerLaunchEndpoint> {
    [
        (
            wire::AttemptEndpointKind::Control,
            "control",
            CONTROL_FRAME_MAX_BYTES,
            wire::RunnerExpectedPeerRole::Host,
            1_u8,
        ),
        (
            wire::AttemptEndpointKind::Data,
            "data",
            DATA_FRAME_MAX_BYTES,
            wire::RunnerExpectedPeerRole::Host,
            2_u8,
        ),
        (
            wire::AttemptEndpointKind::RunnerPulse,
            "pulse",
            PULSE_FRAME_MAX_BYTES,
            wire::RunnerExpectedPeerRole::Supervisor,
            3_u8,
        ),
    ]
    .into_iter()
    .map(
        |(kind, label, maximum, role, token)| wire::RunnerLaunchEndpoint {
            kind: kind as i32,
            endpoint_id: format!("endpoint:{label}:{fixture}"),
            address: format!(
                "{PIPE_PREFIX}{label}-{:08x}-{fixture:016x}",
                std::process::id()
            ),
            connection_id: format!("connection:{label}:{fixture}"),
            connection_token: vec![token; 32],
            max_frame_bytes: maximum as u64,
            provisioning: if unix {
                wire::RunnerEndpointProvisioning::UnixReceiveBoundSocket as i32
            } else {
                wire::RunnerEndpointProvisioning::WindowsCreateNamedPipe as i32
            },
            listener_slot: wire::RunnerListenerSlot::Unspecified as i32,
            expected_peer_role: role as i32,
        },
    )
    .collect()
}

fn endpoint_addresses(handoff: &wire::RunnerLaunchHandoff) -> Vec<String> {
    handoff
        .endpoints
        .iter()
        .map(|endpoint| endpoint.address.clone())
        .collect()
}

fn capacity_for(address: &str) -> EndpointBufferCapacity {
    let bytes = if address.contains("control") {
        CONTROL_FRAME_MAX_BYTES
    } else if address.contains("data") {
        DATA_FRAME_MAX_BYTES
    } else {
        PULSE_FRAME_MAX_BYTES
    };
    EndpointBufferCapacity::new(u32::try_from(bytes).expect("frame cap fits u32"))
        .expect("valid endpoint capacity")
}

fn peer_pids() -> (u32, u32) {
    let current = std::process::id();
    let host = distinct_pid(&[current]);
    let supervisor = distinct_pid(&[current, host]);
    (host, supervisor)
}

fn distinct_pid(excluded: &[u32]) -> u32 {
    (1..=u32::MAX)
        .find(|candidate| !excluded.contains(candidate))
        .expect("finite exclusion cannot cover every PID")
}

fn identity() -> wire::AttemptIdentity {
    wire::AttemptIdentity {
        session_id: "11111111-1111-4111-8111-111111111111".into(),
        command_id: "22222222-2222-4222-8222-222222222222".into(),
        agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        attempt_id: "44444444-4444-4444-8444-444444444444".into(),
        executor_owner_id: "runner-owner-1".into(),
        fencing_epoch: 7,
        correlation_id: "55555555-5555-4555-8555-555555555555".into(),
        root_agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        ..Default::default()
    }
}

const fn budget() -> wire::ResourceBudget {
    wire::ResourceBudget {
        soft_memory_bytes: 32 * 1_024 * 1_024,
        hard_memory_bytes: 64 * 1_024 * 1_024,
        cpu_time_ms: 1_000,
        max_wall_ms: 9_000,
        max_processes: 4,
        max_threads: 8,
        max_open_handles: 64,
        max_hot_transcript_bytes: 16 * 1_024,
        max_ipc_frames: 128,
        max_ipc_bytes: 1_024 * 1_024,
        max_spool_bytes: 64 * 1_024,
        max_artifact_bytes: 32 * 1_024,
        max_concurrent_tools: 2,
        max_blocking_tasks: 2,
        cancel_grace_ms: 100,
    }
}

fn containment() -> wire::ContainmentReport {
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
            ..Default::default()
        }),
    }
}
