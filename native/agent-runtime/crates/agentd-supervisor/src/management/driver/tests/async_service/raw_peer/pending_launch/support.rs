use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use agent_protocol::management_channel::AsyncEstablishedManagementActor;

use crate::management::driver::SupervisorPhysicalDriver;
use crate::management::driver::tests::fakes::{
    BlockingContainment, BlockingLaunchGate, ContainmentState, FakeError, FakeProvisioner,
};
use crate::management::driver::tests::support::{
    TestWriter, established, established_with_maximum_in_flight, launch_attempt, launch_frame,
    peer_authority, trusted_runner,
};
use crate::management::{
    OnlineLifecycleShutdown, OnlineLifecycleShutdownHandle, SupervisorAsyncService,
    SupervisorAsyncServiceAdvance, SupervisorLifecycleClock, SupervisorLifecycleCore,
    SupervisorManagementChannel, SupervisorOnlineLifecycleTimer, SystemSupervisorLifecycleClock,
    TokioSupervisorLifecycleTimer,
};

pub(super) const ANTI_HANG: Duration = Duration::from_secs(4);

type BlockingCore = SupervisorLifecycleCore<BlockingContainment, FakeProvisioner>;
type BlockingDriver<R> =
    SupervisorPhysicalDriver<R, TestWriter, BlockingContainment, FakeProvisioner>;
type BlockingDriverParts<R> = (
    BlockingDriver<R>,
    Arc<ContainmentState>,
    BlockingLaunchGate,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
);
type SystemService = SupervisorAsyncService<
    BlockingContainment,
    FakeProvisioner,
    SystemSupervisorLifecycleClock,
    TokioSupervisorLifecycleTimer,
>;

pub(super) fn empty_blocking_core() -> (
    BlockingCore,
    Arc<ContainmentState>,
    BlockingLaunchGate,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
) {
    let channel = established_with_maximum_in_flight(Vec::new(), TestWriter::default(), 4);
    core_from(channel, 1, 1)
}

pub(super) fn sibling_core() -> (
    BlockingCore,
    Arc<ContainmentState>,
    BlockingLaunchGate,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
) {
    let mut launch = launch_attempt();
    let now = super::super::now_unix_ms();
    launch.authority_lease_expires_at_unix_ms = now + 250;
    launch.hard_deadline_at_unix_ms = now + 1_000;
    let watchdog_deadline = launch.authority_lease_expires_at_unix_ms;
    launch.idempotency_key = "launch:sibling".into();
    launch.launch_nonce[0] = 9;
    launch.identity.as_mut().expect("identity").attempt_id =
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into();
    let channel = established(
        vec![launch_frame(launch, "launch:sibling", 2)],
        TestWriter::default(),
    );
    let (mut driver, containment, gate, prepares, completions) = core_driver(channel, 2, 2);
    driver.process_next().expect("sibling launch");
    assert_eq!(
        driver.state().next_cleanup_deadline_unix_ms(),
        Some(watchdog_deadline)
    );
    (driver.core, containment, gate, prepares, completions)
}

fn core_from<R>(
    channel: SupervisorManagementChannel<R, TestWriter>,
    group_count: usize,
    blocked_call: usize,
) -> (
    BlockingCore,
    Arc<ContainmentState>,
    BlockingLaunchGate,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
)
where
    R: std::io::Read,
{
    let (driver, containment, gate, prepares, completions) =
        core_driver(channel, group_count, blocked_call);
    (driver.core, containment, gate, prepares, completions)
}

fn core_driver<R>(
    channel: SupervisorManagementChannel<R, TestWriter>,
    group_count: usize,
    blocked_call: usize,
) -> BlockingDriverParts<R>
where
    R: std::io::Read,
{
    let (containment, state, gate) = BlockingContainment::healthy(group_count, blocked_call);
    let provisioner = FakeProvisioner::successful();
    let prepares = Arc::clone(&provisioner.calls);
    let completions = Arc::clone(&provisioner.complete_calls);
    let driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("blocking launch driver");
    (driver, state, gate, prepares, completions)
}

pub(super) fn system_service(
    actor: AsyncEstablishedManagementActor,
    core: BlockingCore,
) -> (OnlineLifecycleShutdownHandle, SystemService) {
    SupervisorAsyncService::new(
        actor,
        core,
        SystemSupervisorLifecycleClock::new().expect("system lifecycle clock"),
        TokioSupervisorLifecycleTimer,
    )
}

pub(super) async fn resolve_pending_launch<C, T>(
    service: &mut SupervisorAsyncService<BlockingContainment, FakeProvisioner, C, T>,
) -> SupervisorAsyncServiceAdvance<FakeError>
where
    C: SupervisorLifecycleClock,
    T: SupervisorOnlineLifecycleTimer,
{
    let mut observed = Vec::new();
    for _ in 0..8 {
        let outcome = tokio::time::timeout(ANTI_HANG, service.advance())
            .await
            .expect("pending launch resolution");
        if matches!(outcome, SupervisorAsyncServiceAdvance::LaunchResolved(_)) {
            return outcome;
        }
        observed.push(format!("{outcome:?}"));
    }
    panic!("pending launch did not resolve after bounded transitions: {observed:?}");
}

pub(super) fn request_shutdown_at(shutdown: &OnlineLifecycleShutdownHandle, deadline: i64) {
    shutdown
        .request(OnlineLifecycleShutdown::new(deadline).expect("shutdown deadline"))
        .expect("shutdown request");
}

pub(super) async fn wait_for_blocked_spawn<C, T>(
    service: &mut SupervisorAsyncService<BlockingContainment, FakeProvisioner, C, T>,
    gate: &BlockingLaunchGate,
) where
    C: SupervisorLifecycleClock,
    T: SupervisorOnlineLifecycleTimer,
{
    let mut advance = Box::pin(service.advance());
    tokio::select! {
        biased;
        entered = tokio::time::timeout(ANTI_HANG, gate.wait_until_entered()) => {
            entered.expect("physical spawn reached gate");
        }
        outcome = &mut advance => panic!("launch resolved before gate release: {outcome:?}"),
    }
    drop(advance);
    assert!(service.has_pending_launch());
}

pub(super) fn assert_effect_counts(
    prepares: &AtomicUsize,
    completions: &AtomicUsize,
    expected_prepares: usize,
    expected_completions: usize,
) {
    assert_eq!(prepares.load(Ordering::SeqCst), expected_prepares);
    assert_eq!(completions.load(Ordering::SeqCst), expected_completions);
}
