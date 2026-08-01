use std::time::{Duration, Instant};

use agent_platform::containment::ResourceGroupId;
use agent_protocol::identity::{
    AgentRunId, AttemptId, AttemptIdentity, CommandId, CorrelationId, ExecutorOwnerId,
    RuntimeInstanceId, SessionId,
};

use super::PulseRegistry;
use crate::management::driver::provision::pulse::{
    ProtectedRunnerPulseMonitor, RunnerPulseMonitorState, RunnerPulseObservation,
};
use crate::process_table::{AttemptRuntimeMetadata, OwnershipKey};

#[test]
fn failed_monitor_expires_only_its_attempt() {
    let mut registry = PulseRegistry::new(2);
    let (first, first_updates) = monitor(100, 2_000, 1);
    let (second, _second_updates) = monitor(100, 2_000, 1);
    let first_key = key("44444444-4444-4444-8444-444444444444", "runtime-1");
    let second_key = key("99999999-9999-4999-8999-999999999999", "runtime-2");
    registry
        .insert(first_key.clone(), first, 1_000)
        .expect("first monitor");
    registry
        .insert(second_key, second, 1_000)
        .expect("second monitor");

    first_updates
        .send(RunnerPulseMonitorState::Failed)
        .expect("monitor retained");
    assert_eq!(
        registry.take_expired(1_001).expect("evaluate pulse"),
        vec![first_key]
    );
    assert!(registry.next_deadline_unix_ms().is_some());
    assert!(
        registry
            .take_expired(1_001)
            .expect("sibling live")
            .is_empty()
    );
}

#[test]
fn a_fresh_pulse_never_renews_the_immutable_hard_deadline() {
    let mut registry = PulseRegistry::new(1);
    let (monitor, updates) = monitor(100, 1_050, 1);
    let key = key("44444444-4444-4444-8444-444444444444", "runtime-1");
    registry
        .insert(key.clone(), monitor, 1_000)
        .expect("monitor");
    updates
        .send(RunnerPulseMonitorState::Live(
            RunnerPulseObservation::new_for_test(2, Instant::now()),
        ))
        .expect("monitor retained");

    assert!(
        registry
            .take_expired(1_040)
            .expect("before hard deadline")
            .is_empty()
    );
    assert_eq!(
        registry.take_expired(1_050).expect("at hard deadline"),
        vec![key]
    );
}

fn monitor(
    timeout_ms: u64,
    hard_deadline_at_unix_ms: i64,
    counter: u64,
) -> (
    ProtectedRunnerPulseMonitor,
    tokio::sync::watch::Sender<RunnerPulseMonitorState>,
) {
    ProtectedRunnerPulseMonitor::new_for_test(
        Duration::from_millis(timeout_ms),
        hard_deadline_at_unix_ms,
        RunnerPulseObservation::new_for_test(counter, Instant::now()),
    )
}

fn key(attempt_id: &str, runtime_id: &str) -> OwnershipKey {
    OwnershipKey::from_metadata(&AttemptRuntimeMetadata {
        identity: AttemptIdentity {
            session_id: SessionId::new("11111111-1111-4111-8111-111111111111").expect("session"),
            command_id: CommandId::new("22222222-2222-4222-8222-222222222222").expect("command"),
            agent_run_id: AgentRunId::new("33333333-3333-4333-8333-333333333333").expect("run"),
            attempt_id: AttemptId::new(attempt_id).expect("attempt"),
            executor_owner_id: ExecutorOwnerId::new("owner").expect("owner"),
            fencing_epoch: 7,
            correlation_id: CorrelationId::new("55555555-5555-4555-8555-555555555555")
                .expect("correlation"),
            root_agent_run_id: AgentRunId::new("33333333-3333-4333-8333-333333333333")
                .expect("root run"),
            owner_agent_run_id: None,
            parent_agent_run_id: None,
        },
        runtime_instance_id: RuntimeInstanceId::new(runtime_id).expect("runtime"),
        resource_group_id: ResourceGroupId(format!("group-{runtime_id}")),
        deadline_at_unix_ms: 2_000,
        lease_expires_at_unix_ms: 1_500,
        cancel_grace_ms: 100,
    })
}
