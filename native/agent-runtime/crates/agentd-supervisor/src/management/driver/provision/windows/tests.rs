use std::ffi::OsString;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use agent_platform::containment::{
    ContainedLaunch, ContainmentPort, ResourceGroupId, SpawnedGroup,
};
use agent_platform::windows::{WindowsContainment, WindowsJobGroup};
use agent_protocol::generated::v1 as wire;

use super::super::super::plan::LaunchPlan;
use super::super::peer::ProtectedLaunchPeerAuthority;
use super::super::request::ProtectedLaunchRequest;
use super::super::staged::ProtectedLaunchPhysicalFacts;
use super::super::{
    PendingProtectedLaunch, ProtectedLaunchCompletion, ProtectedLaunchProvisionPort,
};
use super::{WindowsProtectedLaunchError, WindowsProtectedLaunchProvisioner};

mod fixtures;
mod lifecycle;

use fixtures::{
    budget_wire, endpoint_cap, endpoint_kinds, identity, next_sequence, peer_authority, unix_ms,
};
use lifecycle::{assert_alive_then_terminate_and_reap, reap_terminated, terminate};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[test]
fn rejects_empty_local_startup_window() {
    assert!(matches!(
        WindowsProtectedLaunchProvisioner::new(Duration::ZERO),
        Err(WindowsProtectedLaunchError::InvalidStartupTimeout)
    ));
}

#[test]
fn cancellation_without_an_active_bootstrap_is_a_noop() {
    let provisioner =
        WindowsProtectedLaunchProvisioner::new(Duration::from_secs(1)).expect("provisioner");
    assert!(
        !provisioner
            .cancellation_handle()
            .cancel_current()
            .expect("cancellation registry")
    );
}

#[test]
#[ignore = "run after cargo build -p agent-runner --examples"]
fn production_bootstrap_completes_against_a_contained_runner_process() {
    let fixture = Fixture::prepare(Duration::from_secs(5));
    let (pending, physical, spawned) = fixture.spawn("materialize");
    let completion = fixture.provisioner.complete_after_spawn(pending, &physical);
    let receipt = match completion {
        ProtectedLaunchCompletion::Completed(receipt) => receipt,
        ProtectedLaunchCompletion::CleanupRequired(failure) => {
            let (error, mut cleanup) = failure.into_parts();
            let _ = cleanup.cleanup::<WindowsProtectedLaunchError>();
            let evidence = WindowsContainment::new()
                .reap_group(spawned.group, Duration::from_secs(2))
                .expect("reap failed bootstrap child");
            panic!(
                "contained runner bootstrap failed: {error:?}; child exit={}",
                evidence.exit_code()
            )
        }
    };
    receipt
        .validate(&fixture.plan, &fixture.authority, &physical)
        .expect("receipt remains bound to plan and physical process");
    assert_alive_then_terminate_and_reap(spawned);
}

#[test]
#[ignore = "run after cargo build -p agent-runner --examples"]
fn timeout_returns_cleanup_owner_and_releases_slot_for_retry() {
    let fixture = Fixture::prepare(Duration::from_millis(30));
    let (pending, physical, spawned) = fixture.spawn("hold");
    let completion = fixture.provisioner.complete_after_spawn(pending, &physical);
    terminate(&spawned);
    finish_cleanup(completion);
    reap_terminated(spawned);
    let retry = fixture
        .provisioner
        .prepare(&fixture.request())
        .expect("failed completion releases cancellation slot for a fresh attempt");
    drop(retry);
}

#[test]
#[ignore = "run after cargo build -p agent-runner --examples"]
fn external_cancel_returns_cleanup_owner_without_a_helper_thread() {
    let fixture = Fixture::prepare(Duration::from_secs(2));
    let cancellation = fixture.provisioner.cancellation_handle();
    let (pending, physical, spawned) = fixture.spawn("hold");
    assert!(
        cancellation
            .cancel_current()
            .expect("cancel active bootstrap")
    );
    let completion = fixture.provisioner.complete_after_spawn(pending, &physical);
    terminate(&spawned);
    finish_cleanup(completion);
    reap_terminated(spawned);
}

struct Fixture {
    provisioner: WindowsProtectedLaunchProvisioner,
    launch: wire::LaunchAttemptProcess,
    plan: LaunchPlan,
    authority: ProtectedLaunchPeerAuthority,
}

impl Fixture {
    fn prepare(startup_timeout: Duration) -> Self {
        let launch = launch_attempt();
        let plan = LaunchPlan::from_validated(&launch, [9; 32]).expect("launch plan");
        let authority = peer_authority();
        Self {
            provisioner: WindowsProtectedLaunchProvisioner::new(startup_timeout)
                .expect("provisioner"),
            launch,
            plan,
            authority,
        }
    }

    fn request(&self) -> ProtectedLaunchRequest<'_> {
        ProtectedLaunchRequest::new(&self.launch, &self.plan, &self.authority, 100)
    }

    fn spawn(
        &self,
        child_test: &str,
    ) -> (
        PendingProtectedLaunch<super::PendingWindowsProtectedLaunch>,
        ProtectedLaunchPhysicalFacts,
        SpawnedGroup<WindowsJobGroup>,
    ) {
        let prepared = self
            .provisioner
            .prepare(&self.request())
            .expect("prepare protected bootstrap");
        let (handles, pending) = prepared.into_spawn_parts();
        let adapter = WindowsContainment::new();
        let spawned = adapter
            .spawn_runner_contained_with_handles(
                ResourceGroupId(format!("windows-bootstrap-{}", next_sequence())),
                self.plan.budget(),
                &child_launch(child_test),
                handles,
            )
            .expect("spawn contained child");
        let physical = ProtectedLaunchPhysicalFacts::new_for_windows_test(
            spawned.process_id.0,
            spawned.report.clone(),
        );
        (pending, physical, spawned)
    }
}

fn finish_cleanup(
    completion: ProtectedLaunchCompletion<
        super::WindowsProtectedLaunchCleanup,
        WindowsProtectedLaunchError,
    >,
) {
    let failure = match completion {
        ProtectedLaunchCompletion::CleanupRequired(failure) => failure,
        ProtectedLaunchCompletion::Completed(_) => panic!("bootstrap unexpectedly completed"),
    };
    let (_, mut cleanup) = failure.into_parts();
    for _ in 0..100 {
        if cleanup.cleanup::<WindowsProtectedLaunchError>().is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("kernel did not prove bootstrap I/O cleanup");
}

fn child_launch(mode: &str) -> ContainedLaunch {
    let system_root = std::env::var_os("SystemRoot").expect("Windows has SystemRoot");
    ContainedLaunch {
        executable: bootstrap_child_executable(),
        arguments: vec![OsString::from(mode)],
        working_directory: std::env::temp_dir(),
        environment: vec![
            (OsString::from("SystemRoot"), system_root.clone()),
            (OsString::from("WINDIR"), system_root),
        ],
    }
}

fn bootstrap_child_executable() -> std::path::PathBuf {
    let test_executable = std::env::current_exe().expect("test executable");
    let profile = test_executable
        .parent()
        .and_then(std::path::Path::parent)
        .expect("target profile directory");
    let executable = profile
        .join("examples")
        .join("agent-runner-bootstrap-child.exe");
    assert!(
        executable.is_file(),
        "bootstrap E2E helper was not built: {}",
        executable.display()
    );
    executable
}

fn launch_attempt() -> wire::LaunchAttemptProcess {
    let sequence = next_sequence();
    let now = unix_ms();
    wire::LaunchAttemptProcess {
        identity: Some(identity(sequence)),
        resource_budget: Some(budget_wire()),
        hard_deadline_at_unix_ms: now + 10_000,
        authority_lease_expires_at_unix_ms: now + 8_000,
        launch_nonce: vec![5; 32],
        protected_endpoints: endpoint_kinds()
            .into_iter()
            .enumerate()
            .map(|(index, kind)| endpoint(sequence, index, kind))
            .collect(),
        expected_runner_provenance: Some(wire::ExpectedRuntimeProvenance {
            build_id: "runner-build".into(),
            source_commit: "runner-commit".into(),
            binary_sha256: vec![8; 32],
            operating_system: "windows".into(),
            architecture: "x86_64".into(),
        }),
        idempotency_key: format!("windows-launch-{sequence}"),
        required_enforced_limits: Vec::new(),
        activation_authority_seal: Some(activation_authority_seal()),
    }
}

fn activation_authority_seal() -> wire::ActivationAuthoritySeal {
    wire::ActivationAuthoritySeal {
        agent_run_version: 8,
        attempt_version: 5,
        activation_nonce_sha256: vec![7; 32],
    }
}

fn endpoint(
    sequence: u64,
    index: usize,
    kind: wire::AttemptEndpointKind,
) -> wire::ProtectedAttemptEndpoint {
    let label = kind.as_str_name().to_ascii_lowercase().replace('_', "-");
    wire::ProtectedAttemptEndpoint {
        kind: kind as i32,
        endpoint_id: format!("endpoint-{sequence}-{label}"),
        address: format!(r"\\.\pipe\codestudio-agent-v1-supervisor-{sequence}-{label}"),
        connection_token: vec![u8::try_from(index + 1).expect("three endpoints"); 32],
        max_frame_bytes: endpoint_cap(kind) as u64,
        connection_id: format!("connection-{sequence}-{label}"),
    }
}
