#![cfg(windows)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use agent_platform::ipc::{EndpointBufferCapacity, EndpointName};
use agent_platform::windows::ipc::WindowsProtectedEndpoint;
use agent_protocol::frame::{CONTROL_FRAME_MAX_BYTES, DATA_FRAME_MAX_BYTES, PULSE_FRAME_MAX_BYTES};
use agent_protocol::generated::v1 as wire;
use prost::Message;

static NEXT_ENDPOINT: AtomicU64 = AtomicU64::new(1);

pub struct BridgeFixture {
    pub control: WindowsProtectedEndpoint,
    pub data: WindowsProtectedEndpoint,
    pub pulse: WindowsProtectedEndpoint,
    pub request: wire::HostAttemptBridgeOpenRequest,
}

impl BridgeFixture {
    pub fn new() -> Self {
        let pid = std::process::id();
        let control = endpoint("control", CONTROL_FRAME_MAX_BYTES);
        let data = endpoint("data", DATA_FRAME_MAX_BYTES);
        let pulse = endpoint("pulse", PULSE_FRAME_MAX_BYTES);
        let now = now_unix_ms();
        let identity = identity();
        let budget = budget();
        let endpoints = vec![
            wire_endpoint(
                wire::AttemptEndpointKind::Control,
                "control-endpoint-0001",
                control.address().as_str(),
                "control-connection-0001",
                CONTROL_FRAME_MAX_BYTES as u64,
                0x11,
            ),
            wire_endpoint(
                wire::AttemptEndpointKind::Data,
                "data-endpoint-0001",
                data.address().as_str(),
                "data-connection-0001",
                DATA_FRAME_MAX_BYTES as u64,
                0x22,
            ),
            wire_endpoint(
                wire::AttemptEndpointKind::RunnerPulse,
                "pulse-endpoint-0001",
                pulse.address().as_str(),
                "pulse-connection-0001",
                PULSE_FRAME_MAX_BYTES as u64,
                0x33,
            ),
        ];
        let endpoint_ids = endpoints
            .iter()
            .map(|value| value.endpoint_id.clone())
            .collect();
        let provenance = provenance(pid);
        let request = wire::HostAttemptBridgeOpenRequest {
            launch: Some(wire::LaunchAttemptProcess {
                identity: Some(identity.clone()),
                resource_budget: Some(budget),
                hard_deadline_at_unix_ms: now + 60_000,
                authority_lease_expires_at_unix_ms: now + 50_000,
                launch_nonce: vec![0x44; 32],
                protected_endpoints: endpoints,
                expected_runner_provenance: Some(expected_provenance()),
                idempotency_key: "host-bridge-launch-0001".into(),
                required_enforced_limits: vec![
                    wire::ResourceLimitKind::Memory as i32,
                    wire::ResourceLimitKind::Processes as i32,
                ],
                activation_authority_seal: Some(wire::ActivationAuthoritySeal {
                    agent_run_version: 1,
                    attempt_version: 1,
                    activation_nonce_sha256: vec![0x55; 32],
                }),
            }),
            accepted: Some(wire::LaunchAccepted {
                identity: Some(identity.clone()),
                reservation_id: "reservation-0001".into(),
                reserved_budget: Some(budget),
                hard_deadline_at_unix_ms: now + 60_000,
                accepted_at_unix_ms: now - 30,
            }),
            spawned: Some(wire::AttemptProcessSpawned {
                identity: Some(identity.clone()),
                runner_provenance: Some(provenance.clone()),
                resource_group_id: "resource-group-0001".into(),
                reservation_id: "reservation-0001".into(),
                endpoint_ids,
                spawned_at_unix_ms: now - 20,
            }),
            containment: Some(wire::AttemptContainmentReport {
                identity: Some(identity),
                runtime_instance_id: provenance.runtime_instance_id,
                requested_budget: Some(budget),
                effective_containment: Some(containment()),
                reported_at_unix_ms: now - 10,
            }),
            open_deadline_at_unix_ms: now + 30_000,
            required_containment_level: wire::ContainmentLevel::HardAggregate as i32,
        };
        Self {
            control,
            data,
            pulse,
            request,
        }
    }

    pub fn encoded(&self) -> Vec<u8> {
        self.request.encode_to_vec()
    }
}

fn endpoint(label: &str, bytes: usize) -> WindowsProtectedEndpoint {
    let nonce = NEXT_ENDPOINT.fetch_add(1, Ordering::Relaxed);
    let name = EndpointName::new(format!(
        "host-bridge-{label}-{}-{nonce}",
        std::process::id()
    ))
    .expect("valid endpoint name");
    WindowsProtectedEndpoint::bind(
        &name,
        EndpointBufferCapacity::new(u32::try_from(bytes).expect("capacity fits uint32"))
            .expect("valid capacity"),
    )
    .expect("protected endpoint")
}

fn wire_endpoint(
    kind: wire::AttemptEndpointKind,
    endpoint_id: &str,
    address: &str,
    connection_id: &str,
    max_frame_bytes: u64,
    token: u8,
) -> wire::ProtectedAttemptEndpoint {
    wire::ProtectedAttemptEndpoint {
        kind: kind as i32,
        endpoint_id: endpoint_id.into(),
        address: address.into(),
        connection_token: vec![token; 32],
        max_frame_bytes,
        connection_id: connection_id.into(),
    }
}

fn identity() -> wire::AttemptIdentity {
    wire::AttemptIdentity {
        session_id: "10000000-0000-4000-8000-000000000001".into(),
        command_id: "20000000-0000-4000-8000-000000000002".into(),
        agent_run_id: "30000000-0000-4000-8000-000000000003".into(),
        attempt_id: "40000000-0000-4000-8000-000000000004".into(),
        executor_owner_id: "host-bridge-owner".into(),
        fencing_epoch: 1,
        correlation_id: "50000000-0000-4000-8000-000000000005".into(),
        root_agent_run_id: "60000000-0000-4000-8000-000000000006".into(),
        owner_agent_run_id: None,
        parent_agent_run_id: None,
    }
}

const fn budget() -> wire::ResourceBudget {
    wire::ResourceBudget {
        soft_memory_bytes: 64 * 1024 * 1024,
        hard_memory_bytes: 128 * 1024 * 1024,
        cpu_time_ms: 10_000,
        max_wall_ms: 30_000,
        max_processes: 4,
        max_threads: 16,
        max_open_handles: 128,
        max_hot_transcript_bytes: 1024 * 1024,
        max_ipc_frames: 1024,
        max_ipc_bytes: 1024 * 1024,
        max_spool_bytes: 8 * 1024 * 1024,
        max_artifact_bytes: 4 * 1024 * 1024,
        max_concurrent_tools: 2,
        max_blocking_tasks: 2,
        cancel_grace_ms: 1_000,
    }
}

fn expected_provenance() -> wire::ExpectedRuntimeProvenance {
    wire::ExpectedRuntimeProvenance {
        build_id: "runner-build-0001".into(),
        source_commit: "0123456789abcdef".into(),
        binary_sha256: vec![0x66; 32],
        operating_system: "windows".into(),
        architecture: "x86_64".into(),
    }
}

fn provenance(pid: u32) -> wire::RuntimeProvenance {
    let expected = expected_provenance();
    wire::RuntimeProvenance {
        build_id: expected.build_id,
        source_commit: expected.source_commit,
        binary_sha256: expected.binary_sha256,
        runtime_instance_id: "runtime-instance-0001".into(),
        pid,
        operating_system: expected.operating_system,
        architecture: expected.architecture,
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
            wire::ResourceLimitKind::OpenHandles as i32,
            wire::ResourceLimitKind::ScratchBytes as i32,
        ],
        unsupported_limits: vec![wire::ResourceLimitKind::Threads as i32],
        capabilities: Some(wire::ContainmentCapabilities {
            process_tree: true,
            memory_limit: true,
            cpu_limit: true,
            process_count_limit: true,
            open_file_limit: true,
            filesystem_quota: true,
            network_policy: false,
        }),
    }
}

fn now_unix_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("wall clock")
            .as_millis(),
    )
    .expect("Unix milliseconds")
}
