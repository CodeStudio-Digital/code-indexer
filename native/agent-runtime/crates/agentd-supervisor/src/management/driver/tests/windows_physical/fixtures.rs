use std::ffi::OsString;
use std::io::{Cursor, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_platform::windows::WindowsContainment;
use agent_protocol::framing::DelimitedFrameCodec;
use agent_protocol::generated::v1 as wire;

use super::super::super::{
    ProtectedLaunchPeerAuthority, SupervisorPhysicalDriver, TrustedRunnerConfig,
    TrustedRunnerProvenance, WindowsProtectedLaunchProvisioner,
};
use super::super::support::{
    TestWriter, established, frame, launch_attempt, launch_frame, peer_authority,
};

pub(super) type PhysicalDriver = SupervisorPhysicalDriver<
    Cursor<Vec<u8>>,
    TestWriter,
    WindowsContainment,
    WindowsProtectedLaunchProvisioner,
>;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const HOST_PROBE_INPUT_MAX_BYTES: u32 = 1024 * 1024;

pub(super) struct PhysicalHostProbe {
    child: Child,
    completed: bool,
}

pub(super) fn physical_driver(
    helper: &str,
    startup_timeout: Duration,
) -> (PhysicalDriver, TestWriter, String) {
    let launch = physical_launch_attempt();
    physical_driver_from_launch(
        example_executable(helper),
        startup_timeout,
        launch,
        Vec::new(),
    )
}

pub(super) fn physical_driver_binary(
    startup_timeout: Duration,
) -> (PhysicalDriver, TestWriter, String) {
    physical_driver_from_launch(
        runner_executable(),
        startup_timeout,
        physical_launch_attempt(),
        Vec::new(),
    )
}

pub(super) fn physical_driver_binary_with_host(
    startup_timeout: Duration,
) -> (
    PhysicalDriver,
    TestWriter,
    String,
    wire::LaunchAttemptProcess,
    PhysicalHostProbe,
) {
    let launch = physical_launch_attempt();
    let host = PhysicalHostProbe::spawn();
    let peer_authority = physical_peer_authority(host.process_id());
    let (driver, writer, idempotency_key) = physical_driver_from_launch_with_peer(
        runner_executable(),
        startup_timeout,
        launch.clone(),
        Vec::new(),
        peer_authority,
    );
    (driver, writer, idempotency_key, launch, host)
}

pub(super) fn physical_driver_with_cancel_retry(
    helper: &str,
    startup_timeout: Duration,
) -> (PhysicalDriver, TestWriter, String, i64) {
    let launch = physical_launch_attempt();
    let identity = launch.identity.clone().expect("physical launch identity");
    let grace_deadline_at_unix_ms = launch.authority_lease_expires_at_unix_ms - 500;
    let command = wire::CancelAttemptProcess {
        identity: Some(identity),
        grace_deadline_at_unix_ms,
        reason_code: "test.cancel".into(),
        idempotency_key: "physical-cancel:retry".into(),
    };
    let mut conflicting = command.clone();
    conflicting.reason_code = "test.conflict".into();
    let commands = vec![
        frame(
            wire::management_payload::Body::CancelAttemptProcess(command.clone()),
            "physical-cancel:first",
            3,
        ),
        frame(
            wire::management_payload::Body::CancelAttemptProcess(command),
            "physical-cancel:retry",
            4,
        ),
        frame(
            wire::management_payload::Body::CancelAttemptProcess(conflicting),
            "physical-cancel:conflict",
            5,
        ),
    ];
    let (driver, writer, idempotency_key) = physical_driver_from_launch(
        example_executable(helper),
        startup_timeout,
        launch,
        commands,
    );
    (driver, writer, idempotency_key, grace_deadline_at_unix_ms)
}

fn physical_driver_from_launch(
    executable: PathBuf,
    startup_timeout: Duration,
    launch: wire::LaunchAttemptProcess,
    commands: Vec<Vec<u8>>,
) -> (PhysicalDriver, TestWriter, String) {
    physical_driver_from_launch_with_peer(
        executable,
        startup_timeout,
        launch,
        commands,
        peer_authority(),
    )
}

fn physical_driver_from_launch_with_peer(
    executable: PathBuf,
    startup_timeout: Duration,
    launch: wire::LaunchAttemptProcess,
    commands: Vec<Vec<u8>>,
    peer_authority: ProtectedLaunchPeerAuthority,
) -> (PhysicalDriver, TestWriter, String) {
    let idempotency_key = launch.idempotency_key.clone();
    let writer = TestWriter::default();
    let mut frames = vec![launch_frame(launch, "physical-launch", 2)];
    frames.extend(commands);
    let channel = established(frames, writer.clone());
    let driver = SupervisorPhysicalDriver::new(
        channel,
        WindowsContainment::new(),
        WindowsProtectedLaunchProvisioner::new(startup_timeout).expect("Windows provisioner"),
        trusted_runner(executable),
        peer_authority,
    )
    .expect("physical driver");
    (driver, writer, idempotency_key)
}

impl PhysicalHostProbe {
    fn spawn() -> Self {
        let child = Command::new(example_executable("agent-runner-host-hello-probe"))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn physical Host probe");
        Self {
            child,
            completed: false,
        }
    }

    pub(super) fn process_id(&self) -> u32 {
        self.child.id()
    }

    pub(super) fn complete(
        &mut self,
        launch: &wire::LaunchAttemptProcess,
        runner_process_id: u32,
        runtime_instance_id: &str,
    ) {
        let expected = launch
            .expected_runner_provenance
            .as_ref()
            .expect("expected runner provenance");
        let spawned = wire::AttemptProcessSpawned {
            identity: launch.identity.clone(),
            runner_provenance: Some(wire::RuntimeProvenance {
                build_id: expected.build_id.clone(),
                source_commit: expected.source_commit.clone(),
                binary_sha256: expected.binary_sha256.clone(),
                runtime_instance_id: runtime_instance_id.into(),
                pid: runner_process_id,
                operating_system: expected.operating_system.clone(),
                architecture: expected.architecture.clone(),
            }),
            resource_group_id: "physical-host-probe".into(),
            reservation_id: "physical-host-probe".into(),
            endpoint_ids: launch
                .protected_endpoints
                .iter()
                .map(|endpoint| endpoint.endpoint_id.clone())
                .collect(),
            spawned_at_unix_ms: unix_ms(),
        };
        let codec =
            DelimitedFrameCodec::new(HOST_PROBE_INPUT_MAX_BYTES).expect("host probe input cap");
        let mut input = self.child.stdin.take().expect("Host probe stdin");
        codec
            .write(&mut input, launch)
            .expect("send launch to Host");
        codec
            .write(&mut input, &spawned)
            .expect("send spawned fact to Host");
        input.flush().expect("flush Host probe input");
        drop(input);
        let status = self.child.wait().expect("wait for Host Hello probe");
        let mut stderr = String::new();
        self.child
            .stderr
            .take()
            .expect("Host probe stderr")
            .read_to_string(&mut stderr)
            .expect("read Host probe stderr");
        self.completed = true;
        assert!(status.success(), "Host Hello probe failed: {stderr}");
    }
}

impl Drop for PhysicalHostProbe {
    fn drop(&mut self) {
        if !self.completed {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn physical_peer_authority(host_process_id: u32) -> ProtectedLaunchPeerAuthority {
    ProtectedLaunchPeerAuthority::new_for_test(host_process_id, std::process::id(), None, None)
        .expect("distinct physical Host and supervisor")
}

fn physical_launch_attempt() -> wire::LaunchAttemptProcess {
    let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut launch = launch_attempt();
    let now = unix_ms();
    launch.hard_deadline_at_unix_ms = now + 10_000;
    launch.authority_lease_expires_at_unix_ms = now + 8_000;
    launch.resource_budget = Some(physical_budget());
    launch.required_enforced_limits = vec![
        wire::ResourceLimitKind::Memory as i32,
        wire::ResourceLimitKind::CpuTime as i32,
        wire::ResourceLimitKind::Processes as i32,
    ];
    launch.idempotency_key = format!("physical-launch:{sequence}");
    let identity = launch.identity.as_mut().expect("launch identity");
    identity.attempt_id = format!("44444444-4444-4444-8444-{sequence:012x}");
    identity.correlation_id = format!("55555555-5555-4555-8555-{sequence:012x}");
    for (index, endpoint) in launch.protected_endpoints.iter_mut().enumerate() {
        let kind = wire::AttemptEndpointKind::try_from(endpoint.kind).expect("endpoint kind");
        let label = kind.as_str_name().to_ascii_lowercase().replace('_', "-");
        endpoint.endpoint_id = format!("physical-endpoint:{sequence}:{label}");
        endpoint.connection_id = format!("physical-connection:{sequence}:{label}");
        endpoint.connection_token =
            vec![u8::try_from(index + 1).expect("three physical endpoints"); 32];
        endpoint.address = format!(
            r"\\.\pipe\codestudio-agent-v1-driver-{}-{sequence}-{label}",
            std::process::id()
        );
    }
    launch
}

fn physical_budget() -> wire::ResourceBudget {
    wire::ResourceBudget {
        soft_memory_bytes: 128 * 1024 * 1024,
        hard_memory_bytes: 256 * 1024 * 1024,
        cpu_time_ms: 30_000,
        max_wall_ms: 5_000,
        max_processes: 2,
        max_threads: 32,
        max_open_handles: 256,
        max_hot_transcript_bytes: 1024,
        max_ipc_frames: 32,
        // Data v1 reserves 64 KiB for the bounded envelope; the physical
        // Hello fixture must leave positive payload credit for hydration.
        max_ipc_bytes: 1024 * 1024,
        max_spool_bytes: 4096,
        max_artifact_bytes: 2048,
        max_concurrent_tools: 1,
        max_blocking_tasks: 1,
        cancel_grace_ms: 1000,
    }
}

fn trusted_runner(executable: PathBuf) -> TrustedRunnerConfig {
    let system_root = std::env::var_os("SystemRoot").expect("Windows has SystemRoot");
    TrustedRunnerConfig::new(
        executable,
        std::env::temp_dir(),
        vec![
            (OsString::from("SystemRoot"), system_root.clone()),
            (OsString::from("WINDIR"), system_root),
        ],
        TrustedRunnerProvenance::new(
            "runner-build".into(),
            "runner-commit".into(),
            [8; 32],
            "windows".into(),
            "x86_64".into(),
        )
        .expect("runner provenance"),
    )
    .expect("trusted physical runner")
}

fn example_executable(name: &str) -> PathBuf {
    let test_executable = std::env::current_exe().expect("test executable");
    let profile = test_executable
        .parent()
        .and_then(std::path::Path::parent)
        .expect("target profile directory");
    let executable = profile.join("examples").join(format!("{name}.exe"));
    assert!(
        executable.is_file(),
        "bootstrap E2E helper was not built: {}",
        executable.display()
    );
    executable
}

fn runner_executable() -> PathBuf {
    let test_executable = std::env::current_exe().expect("test executable");
    let profile = test_executable
        .parent()
        .and_then(std::path::Path::parent)
        .expect("target profile directory");
    let executable = profile.join("agent-runner.exe");
    assert!(
        executable.is_file(),
        "production runner was not built: {}",
        executable.display()
    );
    executable
}

fn unix_ms() -> i64 {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("wall clock after Unix epoch");
    i64::try_from(elapsed.as_millis()).expect("test clock fits i64")
}
