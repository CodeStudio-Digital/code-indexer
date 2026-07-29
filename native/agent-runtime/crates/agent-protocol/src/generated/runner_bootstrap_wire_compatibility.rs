use prost::Message;

use super::v1 as wire;
use crate::frame::{CONTROL_FRAME_MAX_BYTES, DATA_FRAME_MAX_BYTES, PULSE_FRAME_MAX_BYTES};
use crate::runner_bootstrap::runner_launch_handoff_sha256;

const GOLDEN_HEX: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../packages/agent-runtime-contracts/fixtures/v1/runner-launch-handoff.hex"
));
const UNIX_GOLDEN_HEX: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../packages/agent-runtime-contracts/fixtures/v1/runner-launch-handoff-unix.hex"
));
const READY_GOLDEN_HEX: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../packages/agent-runtime-contracts/fixtures/v1/runner-endpoints-ready.hex"
));

#[test]
fn rust_encodes_the_shared_runner_handoff_byte_for_byte() {
    let encoded = golden_handoff().encode_to_vec();

    assert_eq!(encoded, decode_hex(GOLDEN_HEX));
    assert_eq!(encoded.len(), 777);
    assert_eq!(
        runner_launch_handoff_sha256(&encoded),
        decode_hex("807193088d6ac318c4ab3c76790b1417fbcb5ba931330cabb2163ec110aebb6b").as_slice()
    );
}

#[test]
fn rust_preserves_runner_handoff_authority_and_uint64_values() {
    let decoded = wire::RunnerLaunchHandoff::decode(decode_hex(GOLDEN_HEX).as_slice())
        .expect("valid runner handoff");

    assert_eq!(
        decoded.identity.expect("identity").fencing_epoch,
        9_007_199_254_740_993
    );
    assert_eq!(
        decoded
            .reserved_resource_budget
            .expect("budget")
            .hard_memory_bytes,
        536_870_912
    );
    assert_eq!(decoded.endpoints.len(), 3);
    assert_eq!(
        decoded.endpoints[0].provisioning,
        wire::RunnerEndpointProvisioning::WindowsCreateNamedPipe as i32
    );
}

#[test]
fn rust_encodes_the_shared_unix_handoff_byte_for_byte() {
    let encoded = golden_unix_handoff().encode_to_vec();
    let decoded =
        wire::RunnerLaunchHandoff::decode(encoded.as_slice()).expect("valid Unix handoff");

    assert_eq!(encoded, decode_hex(UNIX_GOLDEN_HEX));
    assert_eq!(encoded.len(), 792);
    assert_eq!(
        decoded
            .endpoints
            .iter()
            .map(|endpoint| endpoint.listener_slot)
            .collect::<Vec<_>>(),
        [
            wire::RunnerListenerSlot::Control as i32,
            wire::RunnerListenerSlot::Data as i32,
            wire::RunnerListenerSlot::RunnerPulse as i32,
        ]
    );
    assert_eq!(
        decoded.expected_host_peer.expect("host peer").unix_user_id,
        Some(1_000)
    );
}

#[test]
fn rust_encodes_the_shared_ready_acknowledgement_byte_for_byte() {
    let encoded = golden_ready().encode_to_vec();
    let decoded =
        wire::RunnerEndpointsReady::decode(encoded.as_slice()).expect("valid ready evidence");

    assert_eq!(encoded, decode_hex(READY_GOLDEN_HEX));
    assert_eq!(encoded.len(), 526);
    assert_eq!(decoded.endpoints.len(), 3);
    assert_eq!(
        decoded.acknowledged_handoff_sha256,
        decode_hex("807193088d6ac318c4ab3c76790b1417fbcb5ba931330cabb2163ec110aebb6b")
    );
}

#[test]
fn runner_handoff_digest_covers_unknown_fields_in_the_original_bytes() {
    let base = decode_hex(GOLDEN_HEX);
    let mut original = base.clone();
    original.extend_from_slice(&[0x98, 0x06, 0x07]); // field 99, varint 7
    let normalized = wire::RunnerLaunchHandoff::decode(original.as_slice())
        .expect("handoff with unknown field")
        .encode_to_vec();

    assert_eq!(normalized, base);
    assert_eq!(
        runner_launch_handoff_sha256(&original),
        decode_hex("27bccbfd8cc7e4d7346bfc3829647926f3e7b4565811c06f154925a28159bb07").as_slice()
    );
    assert_ne!(
        runner_launch_handoff_sha256(&original),
        runner_launch_handoff_sha256(&normalized)
    );
}

fn golden_handoff() -> wire::RunnerLaunchHandoff {
    golden_handoff_for_platform(false)
}

fn golden_unix_handoff() -> wire::RunnerLaunchHandoff {
    golden_handoff_for_platform(true)
}

fn golden_handoff_for_platform(unix: bool) -> wire::RunnerLaunchHandoff {
    wire::RunnerLaunchHandoff {
        schema_version: 1,
        identity: Some(identity()),
        runtime_instance_id: "runtime:opaque/7".into(),
        runner_process_id: 303,
        endpoints: endpoints(unix),
        launch_nonce: (1_u8..=32).collect(),
        hard_deadline_at_unix_ms: 1_784_894_460_123,
        reserved_resource_budget: Some(budget()),
        effective_containment: Some(containment()),
        launch_management_payload_sha256: (32_u8..=63).collect(),
        expected_host_peer: Some(wire::RunnerExpectedLocalPeer {
            process_id: 101,
            unix_user_id: unix.then_some(1_000),
        }),
        expected_supervisor_peer: Some(wire::RunnerExpectedLocalPeer {
            process_id: 202,
            unix_user_id: unix.then_some(1_000),
        }),
        activation_authority_seal: Some(wire::ActivationAuthoritySeal {
            agent_run_version: 8,
            attempt_version: 5,
            activation_nonce_sha256: (64_u8..=95).collect(),
        }),
        // V1 golden predates this compatible additive field.
        runtime_provenance: None,
    }
}

fn golden_ready() -> wire::RunnerEndpointsReady {
    let mut handoff = golden_handoff();
    wire::RunnerEndpointsReady {
        schema_version: handoff.schema_version,
        identity: handoff.identity.take(),
        runtime_instance_id: std::mem::take(&mut handoff.runtime_instance_id),
        runner_process_id: handoff.runner_process_id,
        acknowledged_handoff_sha256: decode_hex(
            "807193088d6ac318c4ab3c76790b1417fbcb5ba931330cabb2163ec110aebb6b",
        ),
        endpoints: std::mem::take(&mut handoff.endpoints)
            .into_iter()
            .map(|mut endpoint| wire::RunnerReadyEndpoint {
                kind: endpoint.kind,
                endpoint_id: std::mem::take(&mut endpoint.endpoint_id),
                address: std::mem::take(&mut endpoint.address),
                connection_id: std::mem::take(&mut endpoint.connection_id),
            })
            .collect(),
    }
}

fn endpoints(unix: bool) -> Vec<wire::RunnerLaunchEndpoint> {
    [
        (
            wire::AttemptEndpointKind::Control,
            "control",
            CONTROL_FRAME_MAX_BYTES,
            wire::RunnerExpectedPeerRole::Host,
            wire::RunnerListenerSlot::Control,
            0x11,
        ),
        (
            wire::AttemptEndpointKind::Data,
            "data",
            DATA_FRAME_MAX_BYTES,
            wire::RunnerExpectedPeerRole::Host,
            wire::RunnerListenerSlot::Data,
            0x22,
        ),
        (
            wire::AttemptEndpointKind::RunnerPulse,
            "pulse",
            PULSE_FRAME_MAX_BYTES,
            wire::RunnerExpectedPeerRole::Supervisor,
            wire::RunnerListenerSlot::RunnerPulse,
            0x33,
        ),
    ]
    .into_iter()
    .map(
        |(kind, name, cap, role, slot, token)| wire::RunnerLaunchEndpoint {
            kind: kind as i32,
            endpoint_id: format!("endpoint:{name}"),
            address: if unix {
                format!("unix:slot/{name}/7")
            } else {
                format!(r"\\.\pipe\{name}-7")
            },
            connection_id: format!("connection:{name}/7"),
            connection_token: vec![token; 16],
            max_frame_bytes: cap as u64,
            provisioning: if unix {
                wire::RunnerEndpointProvisioning::UnixReceiveBoundSocket as i32
            } else {
                wire::RunnerEndpointProvisioning::WindowsCreateNamedPipe as i32
            },
            listener_slot: if unix {
                slot as i32
            } else {
                wire::RunnerListenerSlot::Unspecified as i32
            },
            expected_peer_role: role as i32,
        },
    )
    .collect()
}

fn identity() -> wire::AttemptIdentity {
    wire::AttemptIdentity {
        session_id: "11111111-1111-4111-8111-111111111111".into(),
        command_id: "22222222-2222-4222-8222-222222222222".into(),
        agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        attempt_id: "44444444-4444-4444-8444-444444444444".into(),
        executor_owner_id: "host:desktop".into(),
        fencing_epoch: 9_007_199_254_740_993,
        correlation_id: "55555555-5555-4555-8555-555555555555".into(),
        root_agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        owner_agent_run_id: Some("77777777-7777-4777-8777-777777777777".into()),
        parent_agent_run_id: None,
    }
}

fn budget() -> wire::ResourceBudget {
    wire::ResourceBudget {
        soft_memory_bytes: 268_435_456,
        hard_memory_bytes: 536_870_912,
        cpu_time_ms: 120_000,
        max_wall_ms: 180_000,
        max_processes: 8,
        max_threads: 32,
        max_open_handles: 512,
        max_hot_transcript_bytes: 4_194_304,
        max_ipc_frames: 128,
        max_ipc_bytes: 8_388_608,
        max_spool_bytes: 67_108_864,
        max_artifact_bytes: 16_777_216,
        max_concurrent_tools: 4,
        max_blocking_tasks: 4,
        cancel_grace_ms: 5_000,
    }
}

fn containment() -> wire::ContainmentReport {
    wire::ContainmentReport {
        level: wire::ContainmentLevel::HardAggregate as i32,
        enforced_limits: vec![
            wire::ResourceLimitKind::Memory as i32,
            wire::ResourceLimitKind::CpuTime as i32,
            wire::ResourceLimitKind::WallTime as i32,
            wire::ResourceLimitKind::Processes as i32,
        ],
        unsupported_limits: vec![
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

fn decode_hex(source: &str) -> Vec<u8> {
    let source = source.trim().as_bytes();
    assert!(source.len().is_multiple_of(2), "fixture hex must be paired");
    source
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).expect("fixture must be ASCII");
            u8::from_str_radix(pair, 16).expect("fixture must contain valid hex")
        })
        .collect()
}
