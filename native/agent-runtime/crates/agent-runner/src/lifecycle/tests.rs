use super::{RunnerLifecycle, RunnerLifecycleError, RunnerState};
use agent_protocol::identity::{
    AgentRunId, AttemptId, AttemptIdentity, CommandId, CorrelationId, ExecutorOwnerId, SessionId,
};

fn identity(attempt: &str) -> AttemptIdentity {
    AttemptIdentity {
        session_id: SessionId::new("11111111-1111-4111-8111-111111111111").expect("valid ID"),
        command_id: CommandId::new("22222222-2222-4222-8222-222222222222").expect("valid ID"),
        agent_run_id: AgentRunId::new("33333333-3333-4333-8333-333333333333").expect("valid ID"),
        attempt_id: AttemptId::new(attempt).expect("valid ID"),
        executor_owner_id: ExecutorOwnerId::new("runner").expect("valid ID"),
        fencing_epoch: 1,
        correlation_id: CorrelationId::new("55555555-5555-4555-8555-555555555555")
            .expect("valid ID"),
        root_agent_run_id: AgentRunId::new("33333333-3333-4333-8333-333333333333")
            .expect("valid ID"),
        owner_agent_run_id: None,
        parent_agent_run_id: None,
    }
}

#[test]
fn runner_is_single_tenant_even_after_same_attempt_assignment() {
    let mut lifecycle = RunnerLifecycle::default();
    lifecycle
        .assign(identity("44444444-4444-4444-8444-444444444444"))
        .expect("first assignment");

    assert_eq!(
        lifecycle.assign(identity("44444444-4444-4444-8444-444444444444")),
        Err(RunnerLifecycleError::AlreadyAssigned)
    );
    assert_eq!(
        lifecycle.assign(identity("99999999-9999-4999-8999-999999999999")),
        Err(RunnerLifecycleError::AlreadyAssigned)
    );
}

#[test]
fn hydration_requires_an_assigned_attempt() {
    let mut lifecycle = RunnerLifecycle::default();
    lifecycle.transition(RunnerState::Spawning).expect("spawn");
    lifecycle
        .transition(RunnerState::Handshaking)
        .expect("handshake");

    assert_eq!(
        lifecycle.transition(RunnerState::Hydrating),
        Err(RunnerLifecycleError::MissingAttempt {
            target: RunnerState::Hydrating,
        })
    );
}

#[test]
fn effects_are_allowed_only_while_active() {
    let mut lifecycle = RunnerLifecycle::default();
    lifecycle
        .assign(identity("44444444-4444-4444-8444-444444444444"))
        .expect("assignment");

    for next in [
        RunnerState::Spawning,
        RunnerState::Handshaking,
        RunnerState::Hydrating,
        RunnerState::Prepared,
    ] {
        lifecycle
            .transition(next)
            .expect("valid startup transition");
        assert!(!lifecycle.effects_allowed());
    }

    lifecycle
        .transition(RunnerState::Active)
        .expect("activation");
    assert!(lifecycle.effects_allowed());
}

#[test]
fn terminal_exit_requires_the_host_commit_acknowledgement() {
    let mut lifecycle = active_lifecycle();
    lifecycle
        .transition(RunnerState::Terminalizing)
        .expect("terminal proposal");

    assert_eq!(
        lifecycle.transition(RunnerState::Exiting),
        Err(RunnerLifecycleError::DurableCommitRequired {
            state: RunnerState::Terminalizing,
        })
    );
    lifecycle
        .acknowledge_exit_commit()
        .expect("durable terminal acknowledgement");
    lifecycle
        .transition(RunnerState::Exiting)
        .expect("committed exit");
}

#[test]
fn waiting_exit_requires_the_attempt_exit_commit_acknowledgement() {
    let mut lifecycle = active_lifecycle();
    lifecycle
        .transition(RunnerState::AttemptExitPending)
        .expect("checkpointed attempt exit");

    assert!(lifecycle.transition(RunnerState::Exiting).is_err());
    lifecycle
        .acknowledge_exit_commit()
        .expect("durable attempt-exit acknowledgement");
    lifecycle
        .transition(RunnerState::Exiting)
        .expect("committed exit");
}

#[test]
fn forced_physical_exit_does_not_claim_a_durable_terminal() {
    let mut lifecycle = RunnerLifecycle::default();

    assert!(lifecycle.transition(RunnerState::Exiting).is_err());
    lifecycle.force_exit().expect("explicit forced exit");
    lifecycle
        .transition(RunnerState::Reaped)
        .expect("reap after confirmed process exit");
}

fn active_lifecycle() -> RunnerLifecycle {
    let mut lifecycle = RunnerLifecycle::default();
    lifecycle
        .assign(identity("44444444-4444-4444-8444-444444444444"))
        .expect("assignment");
    for next in [
        RunnerState::Spawning,
        RunnerState::Handshaking,
        RunnerState::Hydrating,
        RunnerState::Prepared,
        RunnerState::Active,
    ] {
        lifecycle.transition(next).expect("startup");
    }
    lifecycle
}
