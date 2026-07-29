use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_protocol::generated::v1 as wire;
use agent_protocol::identity::ConnectionId;
use agent_protocol::management_channel::{
    AsyncBootstrapManagementActor, AsyncEstablishedManagementActor, AsyncManagementEvent,
};

use super::super::fakes::{ContainmentState, FakeContainment, FakeProvisioner};
use super::super::support::{
    CONNECTION, NONCE, TOKEN, TestWriter, established, established_with_maximum_in_flight,
    host_hello_with_maximum_in_flight, launch_attempt, launch_frame, peer_authority,
    trusted_runner,
};
use crate::management::{
    OnlineLifecycleShutdownHandle, SupervisorAsyncService, SupervisorDriverStep,
    SupervisorLifecycleCore, SupervisorPhysicalDriver, SystemSupervisorLifecycleClock,
    TokioSupervisorLifecycleTimer,
};

pub(super) type TestCore = SupervisorLifecycleCore<FakeContainment, FakeProvisioner>;
pub(super) type TestService = SupervisorAsyncService<
    FakeContainment,
    FakeProvisioner,
    SystemSupervisorLifecycleClock,
    TokioSupervisorLifecycleTimer,
>;

pub(super) fn launched_core() -> (TestCore, Arc<ContainmentState>) {
    let writer = TestWriter::default();
    let launch = launch_attempt();
    let channel = established(vec![launch_frame(launch, "launch:async-owner", 2)], writer);
    let (containment, state) = FakeContainment::healthy();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("physical driver");
    assert!(matches!(
        driver.process_next().expect("launch owner"),
        SupervisorDriverStep::LaunchAccepted {
            reused_existing: false
        }
    ));
    (driver.core, state)
}

pub(super) fn empty_core() -> TestCore {
    empty_core_with(FakeProvisioner::successful()).0
}

pub(super) fn empty_core_with(provisioner: FakeProvisioner) -> (TestCore, Arc<ContainmentState>) {
    let channel = established_with_maximum_in_flight(Vec::new(), TestWriter::default(), 4);
    let (containment, state) = FakeContainment::healthy();
    let core = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("empty physical driver")
    .core;
    (core, state)
}

pub(super) fn service(
    actor: AsyncEstablishedManagementActor,
    core: TestCore,
) -> (OnlineLifecycleShutdownHandle, TestService) {
    SupervisorAsyncService::new(
        actor,
        core,
        SystemSupervisorLifecycleClock::new().expect("system lifecycle clock"),
        TokioSupervisorLifecycleTimer,
    )
}

pub(super) async fn async_pair() -> (
    AsyncEstablishedManagementActor,
    AsyncEstablishedManagementActor,
) {
    let (host_stream, supervisor_stream) = tokio::io::duplex(256 * 1024);
    let connection = ConnectionId::new(CONNECTION).expect("connection");
    let host = AsyncBootstrapManagementActor::host(
        host_stream,
        connection.clone(),
        NONCE.to_vec(),
        TOKEN.to_vec(),
    )
    .expect("host bootstrap");
    let supervisor = AsyncBootstrapManagementActor::supervisor(
        supervisor_stream,
        connection,
        NONCE.to_vec(),
        TOKEN.to_vec(),
    )
    .expect("supervisor bootstrap");
    let hello = host_hello_with_maximum_in_flight(4);
    let supervisor_hello = supervisor_hello();
    let (host, supervisor) = tokio::join!(
        host.establish_host(&hello),
        supervisor.establish_supervisor(&supervisor_hello)
    );
    (
        host.expect("host established"),
        supervisor.expect("supervisor established"),
    )
}

pub(super) fn fence_command() -> wire::ManagementPayload {
    wire::ManagementPayload {
        body: Some(wire::management_payload::Body::FenceAttemptProcess(
            wire::FenceAttemptProcess {
                identity: launch_attempt().identity,
                replacement_fencing_epoch: 2,
                reason_code: "test.async-fence".into(),
                fenced_at_unix_ms: now_unix_ms().saturating_sub(1_000),
                idempotency_key: "fence:async-service".into(),
            },
        )),
    }
}

pub(super) async fn assert_acknowledged(host: &mut AsyncEstablishedManagementActor) {
    let event = tokio::time::timeout(Duration::from_secs(1), host.receive())
        .await
        .expect("ACK deadline")
        .expect("host actor open")
        .expect("valid ACK");
    assert!(matches!(event, AsyncManagementEvent::Acknowledged(_)));
}

#[derive(Debug)]
pub(super) struct FixedClock(pub(super) i64);

impl crate::management::SupervisorLifecycleClock for FixedClock {
    fn now_unix_ms(&self) -> i64 {
        self.0
    }
}

pub(super) fn supervisor_hello() -> wire::SupervisorHello {
    let version = wire::ProtocolVersion { major: 1, minor: 1 };
    wire::SupervisorHello {
        supported_protocols: Some(wire::ProtocolVersionRange {
            minimum: Some(version),
            maximum: Some(version),
        }),
        contract_version: "contract:test".into(),
        contract_schema_version: 1,
        provenance: Some(wire::RuntimeProvenance {
            build_id: "supervisor-build".into(),
            source_commit: "supervisor-commit".into(),
            binary_sha256: vec![1; 32],
            runtime_instance_id: "supervisor:async-runtime".into(),
            pid: std::process::id(),
            operating_system: "windows".into(),
            architecture: "x86_64".into(),
        }),
        launch_nonce: NONCE.to_vec(),
        containment: Some(wire::ContainmentCapabilities {
            process_tree: true,
            memory_limit: true,
            cpu_limit: true,
            process_count_limit: true,
            ..wire::ContainmentCapabilities::default()
        }),
        supported_feature_bits: 0,
    }
}

fn now_unix_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_millis(),
    )
    .expect("timestamp fits")
}
