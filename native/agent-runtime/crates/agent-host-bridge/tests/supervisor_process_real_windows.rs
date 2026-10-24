#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_host_bridge::AuthenticatedHostSupervisorChannel;
use agent_protocol::generated::v1 as wire;
use agent_protocol::identity::ConnectionId;
use agent_protocol::management_channel::{AsyncBootstrapManagementActor, AsyncManagementEvent};
use agent_protocol::management_frame::MANAGEMENT_FRAME_MAX_BYTES;
use agent_protocol::supervisor_bootstrap::SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION;
use prost::Message;
use sha2::{Digest, Sha256};

const TOKEN: &[u8] = &[0x61; 32];
const NONCE: &[u8] = &[0x82; 32];

#[tokio::test(flavor = "current_thread")]
async fn host_launcher_negotiates_and_reaps_packaged_supervisor() {
    let supervisor_executable = runtime_binary("agentd-supervisor.exe");
    let runner_executable = runtime_binary("agent-runner.exe");
    let supervisor = provenance("supervisor-host-launcher", &supervisor_executable);
    let runner = provenance("runner-host-launcher", &runner_executable);
    let suffix = unique_suffix();
    let connection = format!("management:host-launcher:{suffix}");
    let request = bridge_request(
        &connection,
        suffix,
        &supervisor_executable,
        &runner_executable,
        supervisor.clone(),
        runner.clone(),
    );

    let owner = AuthenticatedHostSupervisorChannel::open(request.encode_to_vec())
        .await
        .expect("launch authenticated supervisor");
    assert_eq!(owner.binding().connection_id(), connection);
    assert!(owner.binding().peer_pid() > 0);
    let supervisor_process_id = owner.binding().peer_pid();
    let (_, stream, process) = owner.into_parts();
    let bootstrap = AsyncBootstrapManagementActor::host(
        stream,
        ConnectionId::new(connection.clone()).expect("connection id"),
        NONCE.to_vec(),
        TOKEN.to_vec(),
    )
    .expect("host bootstrap");
    let mut actor = bootstrap
        .establish_host(&host_hello(&connection, supervisor, runner))
        .await
        .expect("physical management Hello");

    actor
        .command_port()
        .send(shutdown_payload())
        .await
        .expect("send transactional shutdown");
    let event = tokio::time::timeout(Duration::from_secs(5), actor.receive())
        .await
        .expect("shutdown ACK deadline")
        .expect("management actor open")
        .expect("valid shutdown ACK");
    assert!(matches!(event, AsyncManagementEvent::Acknowledged(_)));
    drop(actor);

    let evidence = tokio::task::spawn_blocking(move || process.close())
        .await
        .expect("join process reaper")
        .expect("reap supervisor Job");
    assert_eq!(evidence.process_id, supervisor_process_id);
    assert_eq!(evidence.exit_code, 0);
    assert!(!evidence.forced);
}

fn bridge_request(
    connection: &str,
    suffix: u128,
    supervisor_executable: &Path,
    runner_executable: &Path,
    supervisor: wire::ExpectedRuntimeProvenance,
    runner: wire::ExpectedRuntimeProvenance,
) -> wire::HostSupervisorBridgeOpenRequest {
    wire::HostSupervisorBridgeOpenRequest {
        schema_version: SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION,
        management_endpoint_name: format!("host-supervisor-{}-{suffix}", std::process::id()),
        management_connection_id: connection.into(),
        management_session_token: TOKEN.to_vec(),
        supervisor_launch_nonce: NONCE.to_vec(),
        trusted_supervisor_provenance: Some(supervisor),
        trusted_runner_provenance: Some(runner),
        selected_protocol: Some(protocol()),
        supervisor_executable: supervisor_executable.to_string_lossy().into_owned(),
        runner_executable: runner_executable.to_string_lossy().into_owned(),
        startup_timeout_ms: 10_000,
        lifecycle_outbox_directory: String::new(),
    }
}

fn host_hello(
    connection: &str,
    supervisor: wire::ExpectedRuntimeProvenance,
    runner: wire::ExpectedRuntimeProvenance,
) -> wire::HostSupervisorHello {
    wire::HostSupervisorHello {
        selected_protocol: Some(protocol()),
        connection_id: connection.into(),
        contract_version: "contract:host-launcher".into(),
        contract_schema_version: 1,
        expected_supervisor_provenance: Some(supervisor),
        allowed_runner_provenance: vec![runner],
        limits: Some(wire::SupervisorLimits {
            max_active_attempts: 4,
            max_pending_launches: 4,
            max_reserved_memory_bytes: 1024 * 1024 * 1024,
            max_reserved_processes: 16,
            host_disconnect_grace_ms: 1_000,
            runner_pulse_timeout_ms: 500,
        }),
        frame_limits: Some(wire::FrameLimits {
            max_frame_bytes: MANAGEMENT_FRAME_MAX_BYTES as u64,
            max_chunk_bytes: 16 * 1024,
            max_in_flight_frames: 8,
            max_in_flight_bytes: 512 * 1024,
            read_timeout_ms: 2_000,
            write_timeout_ms: 2_000,
            transport_crc32c: false,
        }),
        management_session_token: TOKEN.to_vec(),
        required_containment_level: wire::ContainmentLevel::HardAggregate as i32,
        allowed_feature_bits: 0,
    }
}

fn shutdown_payload() -> wire::ManagementPayload {
    wire::ManagementPayload {
        body: Some(wire::management_payload::Body::ShutdownSupervisor(
            wire::ShutdownSupervisor {
                mode: wire::SupervisorShutdownMode::Drain as i32,
                shutdown_deadline_at_unix_ms: now_unix_ms() + 5_000,
                reason_code: "test.host-launcher".into(),
                idempotency_key: "shutdown:host-launcher".into(),
            },
        )),
    }
}

fn runtime_binary(name: &str) -> PathBuf {
    let test_executable = std::env::current_exe().expect("test executable");
    let profile_directory = test_executable
        .parent()
        .and_then(Path::parent)
        .expect("Cargo profile directory");
    let executable = profile_directory.join(name);
    assert!(
        executable.is_file(),
        "build runtime binaries before this process-real test: {}",
        executable.display()
    );
    executable
}

fn provenance(build_id: &str, executable: &Path) -> wire::ExpectedRuntimeProvenance {
    let binary = std::fs::read(executable).expect("read runtime binary");
    wire::ExpectedRuntimeProvenance {
        build_id: build_id.into(),
        source_commit: "local-process-real".into(),
        binary_sha256: Sha256::digest(binary).to_vec(),
        operating_system: "windows".into(),
        architecture: std::env::consts::ARCH.into(),
    }
}

const fn protocol() -> wire::ProtocolVersion {
    wire::ProtocolVersion { major: 1, minor: 1 }
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time after epoch")
        .as_millis()
}

fn now_unix_ms() -> i64 {
    i64::try_from(unique_suffix()).expect("timestamp fits")
}
