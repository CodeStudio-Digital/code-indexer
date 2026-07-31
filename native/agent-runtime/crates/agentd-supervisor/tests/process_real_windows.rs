#![cfg(windows)]

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_platform::budget::ResourceBudget;
use agent_platform::containment::{
    ChildHandleAllowlist, ContainedLaunch, ContainmentPort, ResourceGroupId, SpawnedGroup,
};
use agent_platform::ipc::{
    EndpointBufferCapacity, EndpointName, ExpectedLocalPeer, endpoint_cancellation,
};
use agent_platform::windows::bootstrap::prepare_windows_bootstrap;
use agent_platform::windows::ipc::WindowsProtectedEndpoint;
use agent_platform::windows::{WindowsContainment, WindowsJobGroup};
use agent_protocol::framing::DelimitedFrameCodec;
use agent_protocol::generated::v1 as wire;
use agent_protocol::identity::ConnectionId;
use agent_protocol::management_channel::{AsyncBootstrapManagementActor, AsyncManagementEvent};
use agent_protocol::management_frame::MANAGEMENT_FRAME_MAX_BYTES;
use agent_protocol::supervisor_bootstrap::{
    SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION, SUPERVISOR_PROCESS_HANDOFF_MAX_BYTES,
    SUPERVISOR_PROCESS_READY_MAX_BYTES,
};
use tokio::time::Instant;

const CONNECTION: &str = "management:process-real";
const TOKEN: &[u8] = &[0x51; 32];
const NONCE: &[u8] = &[0x72; 32];

#[test]
fn packaged_supervisor_owns_management_until_transactional_shutdown() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .expect("test runtime");
    let (containment, spawned, endpoint, supervisor, runner) = launch_supervisor(&runtime);
    drive_shutdown(&runtime, endpoint, spawned.process_id.0, supervisor, runner);
    let evidence = containment
        .reap_group(spawned.group, Duration::from_secs(5))
        .expect("supervisor exited and reaped");
    assert_eq!(evidence.exit_code(), 0);
}

fn launch_supervisor(
    runtime: &tokio::runtime::Runtime,
) -> (
    WindowsContainment,
    SpawnedGroup<WindowsJobGroup>,
    WindowsProtectedEndpoint,
    wire::RuntimeProvenance,
    wire::ExpectedRuntimeProvenance,
) {
    let endpoint_name = EndpointName::new(format!(
        "supervisor-mgmt-{}-{}",
        std::process::id(),
        monotonic_suffix()
    ))
    .expect("management endpoint name");
    let endpoint = {
        let _guard = runtime.enter();
        WindowsProtectedEndpoint::bind(
            &endpoint_name,
            EndpointBufferCapacity::new(64 * 1024).expect("endpoint capacity"),
        )
        .expect("protected management endpoint")
    };
    let endpoint_address = endpoint.address().as_str().to_owned();
    let prepared = prepare_windows_bootstrap().expect("private inherited bootstrap");
    let (parent, child_stdio) = prepared.into_parts();
    let (mut ready_reader, mut handoff_writer) = parent.into_parts();
    let mut handles = ChildHandleAllowlist::new();
    handles
        .install_windows_bootstrap(child_stdio)
        .expect("exact bootstrap handle list");

    let executable = PathBuf::from(env!("CARGO_BIN_EXE_agentd-supervisor"));
    let working_directory = executable.parent().expect("binary directory").to_path_buf();
    let containment = WindowsContainment::new();
    let spawned = containment
        .spawn_runner_contained_with_handles(
            ResourceGroupId("supervisor-process-real".into()),
            &supervisor_budget(),
            &ContainedLaunch {
                executable: executable.clone(),
                arguments: Vec::new(),
                working_directory: working_directory.clone(),
                environment: Vec::new(),
            },
            handles,
        )
        .expect("spawn protected supervisor");

    let supervisor_provenance = wire::RuntimeProvenance {
        build_id: "supervisor-process-real".into(),
        source_commit: "local-test".into(),
        binary_sha256: vec![0x31; 32],
        runtime_instance_id: "supervisor:process-real".into(),
        pid: spawned.process_id.0,
        operating_system: "windows".into(),
        architecture: std::env::consts::ARCH.into(),
    };
    let runner_provenance = expected_runner();
    let handoff = wire::SupervisorProcessHandoff {
        schema_version: SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION,
        host_process_id: std::process::id(),
        management_connection_id: CONNECTION.into(),
        management_endpoint_address: endpoint_address.clone(),
        management_session_token: TOKEN.to_vec(),
        supervisor_launch_nonce: NONCE.to_vec(),
        supervisor_provenance: Some(supervisor_provenance.clone()),
        supported_protocols: Some(protocol_range()),
        containment: Some(containment_capabilities()),
        supported_feature_bits: 0,
        runner_executable: executable.to_string_lossy().into_owned(),
        runner_working_directory: working_directory.to_string_lossy().into_owned(),
        runner_environment: Vec::new(),
        trusted_runner_provenance: Some(runner_provenance.clone()),
    };
    codec(SUPERVISOR_PROCESS_HANDOFF_MAX_BYTES)
        .write(&mut handoff_writer, &handoff)
        .expect("write process handoff");
    std::io::Write::flush(&mut handoff_writer).expect("flush process handoff");
    drop(handoff_writer);

    let ready: wire::SupervisorProcessReady = codec(SUPERVISOR_PROCESS_READY_MAX_BYTES)
        .read(&mut ready_reader)
        .expect("read process Ready")
        .expect("process Ready");
    assert_eq!(ready.supervisor_process_id, spawned.process_id.0);
    assert_eq!(ready.management_connection_id, CONNECTION);
    assert_eq!(ready.management_endpoint_address, endpoint_address);
    assert!(
        codec(SUPERVISOR_PROCESS_READY_MAX_BYTES)
            .read::<wire::SupervisorProcessReady>(&mut ready_reader)
            .expect("Ready EOF")
            .is_none()
    );
    (
        containment,
        spawned,
        endpoint,
        supervisor_provenance,
        runner_provenance,
    )
}

fn drive_shutdown(
    runtime: &tokio::runtime::Runtime,
    endpoint: WindowsProtectedEndpoint,
    supervisor_process_id: u32,
    supervisor_provenance: wire::RuntimeProvenance,
    runner_provenance: wire::ExpectedRuntimeProvenance,
) {
    runtime.block_on(async {
        let (_cancel_handle, mut cancellation) = endpoint_cancellation();
        let stream = endpoint
            .accept(
                ExpectedLocalPeer::new(supervisor_process_id).expect("supervisor peer"),
                Instant::now() + Duration::from_secs(5),
                &mut cancellation,
            )
            .await
            .expect("verified supervisor stream");
        let host = AsyncBootstrapManagementActor::host(
            stream,
            ConnectionId::new(CONNECTION).expect("connection"),
            NONCE.to_vec(),
            TOKEN.to_vec(),
        )
        .expect("host bootstrap");
        let mut actor = host
            .establish_host(&host_hello(supervisor_provenance, runner_provenance))
            .await
            .expect("management Hello");
        actor
            .command_port()
            .send(shutdown_payload())
            .await
            .expect("write shutdown");
        let event = tokio::time::timeout(Duration::from_secs(5), actor.receive())
            .await
            .expect("shutdown ACK deadline")
            .expect("management actor open")
            .expect("valid shutdown ACK");
        assert!(matches!(event, AsyncManagementEvent::Acknowledged(_)));
        drop(actor);
    });
}

fn host_hello(
    actual: wire::RuntimeProvenance,
    runner: wire::ExpectedRuntimeProvenance,
) -> wire::HostSupervisorHello {
    wire::HostSupervisorHello {
        selected_protocol: Some(version()),
        connection_id: CONNECTION.into(),
        contract_version: "contract:process-real".into(),
        contract_schema_version: 1,
        expected_supervisor_provenance: Some(wire::ExpectedRuntimeProvenance {
            build_id: actual.build_id,
            source_commit: actual.source_commit,
            binary_sha256: actual.binary_sha256,
            operating_system: actual.operating_system,
            architecture: actual.architecture,
        }),
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
                reason_code: "test.process-real".into(),
                idempotency_key: "shutdown:process-real".into(),
            },
        )),
    }
}

const fn version() -> wire::ProtocolVersion {
    wire::ProtocolVersion { major: 1, minor: 1 }
}

const fn protocol_range() -> wire::ProtocolVersionRange {
    wire::ProtocolVersionRange {
        minimum: Some(version()),
        maximum: Some(version()),
    }
}

fn containment_capabilities() -> wire::ContainmentCapabilities {
    wire::ContainmentCapabilities {
        process_tree: true,
        memory_limit: true,
        cpu_limit: true,
        process_count_limit: true,
        ..wire::ContainmentCapabilities::default()
    }
}

fn expected_runner() -> wire::ExpectedRuntimeProvenance {
    wire::ExpectedRuntimeProvenance {
        build_id: "runner-process-real".into(),
        source_commit: "local-test".into(),
        binary_sha256: vec![0x52; 32],
        operating_system: "windows".into(),
        architecture: std::env::consts::ARCH.into(),
    }
}

const fn supervisor_budget() -> ResourceBudget {
    ResourceBudget {
        soft_memory_bytes: 128 * 1024 * 1024,
        hard_memory_bytes: 256 * 1024 * 1024,
        cpu_time_ms: 60_000,
        max_wall_ms: 30_000,
        max_processes: 8,
        max_threads: 32,
        max_open_handles: 512,
        max_hot_transcript_bytes: 1024,
        max_ipc_frames: 64,
        max_ipc_bytes: 1024 * 1024,
        max_spool_bytes: 1024,
        max_artifact_bytes: 1024,
        max_concurrent_tools: 1,
        max_blocking_tasks: 1,
        cancel_grace_ms: 1_000,
    }
}

fn codec(maximum: usize) -> DelimitedFrameCodec {
    DelimitedFrameCodec::new(u32::try_from(maximum).expect("cap fits")).expect("non-zero cap")
}

fn monotonic_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time after epoch")
        .as_nanos()
}

fn now_unix_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time after epoch")
            .as_millis(),
    )
    .expect("timestamp fits")
}
