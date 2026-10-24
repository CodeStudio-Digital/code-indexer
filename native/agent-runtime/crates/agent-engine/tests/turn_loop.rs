use std::collections::VecDeque;
use std::convert::Infallible;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::future::{Future, ready};

use agent_engine::lifecycle::RunState;
use agent_engine::limits::EngineLimits;
use agent_engine::operation::OperationId;
use agent_engine::ports::{
    AuthorityCheckpoint, AuthorityPort, ClockPort, EngineEvent, EventSinkPort, ProviderEvent,
    ProviderGatewayPort, ProviderRequest, ProviderToolCall, ProviderUsage, TerminalClassification,
    TerminalRecord,
};
use agent_engine::turn::{TurnEngine, TurnInput, TurnOutcome};
use agent_tools::capability::{
    CapabilityDecision, CapabilityExecutionOutcome, CapabilityExecutorPort, CapabilityFailure,
    CapabilityGatewayPort, CapabilityInvocation, CapabilityOutput, CapabilityRejection,
    ExecutionClass, NativeFilesystemReadBinding, SealedExecutionGrant,
};

#[tokio::test]
async fn shared_turn_limit_is_an_interruption_but_foreign_authority_is_a_failure() {
    for (reason, classification, code) in [
        (
            "provider_run_tree_budget_exhausted",
            TerminalClassification::Interrupted,
            "max_turns",
        ),
        (
            "provider_run_tree_fenced",
            TerminalClassification::Failed,
            "provider_failed",
        ),
        (
            "provider_failed",
            TerminalClassification::Failed,
            "provider_failed",
        ),
    ] {
        let mut provider = FakeProvider::new([ProviderEvent::Failed {
            reason_code: reason.into(),
        }]);
        let mut authority = FakeAuthority::default();
        let mut events = FakeEvents::default();
        let mut clock = FixedClock(100);
        let mut engine = TurnEngine::new(limits());
        let outcome = engine
            .run(
                input(),
                &mut provider,
                &mut authority,
                &mut events,
                &mut clock,
            )
            .await
            .expect("classified shared control outcome");
        assert_eq!(events.terminal, Some((classification, code.into())));
        if code == "max_turns" {
            assert_eq!(
                outcome,
                TurnOutcome::Interrupted {
                    reason_code: "max_turns"
                }
            );
        } else {
            assert_eq!(
                outcome,
                TurnOutcome::Failed {
                    reason_code: "provider_failed"
                }
            );
        }
    }
}

#[tokio::test]
async fn stateless_provider_completion_is_durable_without_a_remote_response_id() {
    let mut provider = FakeProvider::new([
        ProviderEvent::TextDelta("stateless".into()),
        ProviderEvent::Completed {
            response_id: None,
            response_message_count: None,
        },
    ]);
    let mut authority = FakeAuthority::default();
    let mut events = FakeEvents::default();
    let mut clock = FixedClock(100);
    let mut engine = TurnEngine::new(limits());
    let outcome = engine
        .run(
            input(),
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .expect("stateless completion");
    assert_eq!(
        outcome,
        TurnOutcome::Completed {
            response_id: None,
            text: "stateless".into(),
            usage: None
        }
    );
    assert_eq!(
        events.terminal,
        Some((TerminalClassification::Completed, "completed".into()))
    );
}

#[tokio::test]
async fn text_provider_turn_crosses_terminal_commit_before_completed() {
    let mut provider = FakeProvider::new([
        ProviderEvent::TextDelta("hello ".to_owned()),
        ProviderEvent::TextDelta("world".to_owned()),
        ProviderEvent::Usage(usage(12, 2, 3)),
        ProviderEvent::Completed {
            response_id: Some("response:test".to_owned()),
            response_message_count: None,
        },
    ]);
    let mut authority = FakeAuthority::default();
    let mut events = FakeEvents::default();
    let mut clock = FixedClock(100);
    let mut engine = TurnEngine::new(limits());

    let result = engine
        .run(
            input(),
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .expect("deterministic turn");

    assert_eq!(engine.state(), RunState::Completed);
    assert_eq!(
        result,
        TurnOutcome::Completed {
            response_id: Some("response:test".to_owned()),
            text: "hello world".to_owned(),
            usage: Some(usage(12, 2, 3)),
        }
    );
    assert_eq!(
        authority.checkpoints,
        [
            AuthorityCheckpoint::Hydration,
            AuthorityCheckpoint::ProviderStart,
            AuthorityCheckpoint::TerminalDecision,
        ]
    );
    assert_eq!(
        events.terminal,
        Some((TerminalClassification::Completed, "completed".to_owned()))
    );
    let request = provider.request.expect("provider request");
    assert_eq!(request.encoded_context.as_ref(), b"context");
    assert_eq!(request.deadline_at_unix_ms, 1_000);
}

#[tokio::test]
async fn refusal_settles_once_without_started_and_allows_the_next_provider_turn() {
    let call = tool_call();
    let mut provider = FakeProvider::new([ProviderEvent::ToolCall(call.clone())]);
    let mut authority = FakeAuthority::default();
    let mut events = FakeEvents::default();
    let mut clock = FixedClock(100);
    let mut engine = TurnEngine::new(limits());
    engine
        .run(
            input(),
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .unwrap();
    let batch = engine.capability_batch().unwrap();
    let rejection = CapabilityRejection {
        decision_id: "deny:1".into(),
        reason_code: "user_denied".into(),
        policy_version: "policy:1".into(),
        decided_at_unix_ms: 100,
    };
    let outcome = batch
        .refuse(
            &call,
            &rejection,
            1_000,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .unwrap();
    assert!(matches!(outcome, CapabilityExecutionOutcome::Failed(_)));
    assert_eq!(events.capability_lifecycle, ["refused"]);
    assert!(
        batch
            .refuse(
                &call,
                &rejection,
                1_000,
                &mut authority,
                &mut events,
                &mut clock
            )
            .await
            .is_err()
    );
    engine.finish_capability_batch(batch).unwrap();
    let mut next_call = call;
    next_call.operation_id = operation("provider:2");
    let mut provider = FakeProvider::new([ProviderEvent::ToolCall(next_call.clone())]);
    let mut next = input();
    next.operation_id = next_call.operation_id.clone();
    engine
        .resume_after_capability(next, &mut provider, &mut authority, &mut events, &mut clock)
        .await
        .unwrap();
    let mut gateway = FakeCapabilities::default();
    engine
        .prepare_capability(&next_call, [9; 32], 1_000, &mut gateway, &mut authority)
        .await
        .unwrap();
    let request = gateway.request.unwrap();
    assert_eq!(request.tool_use_id, "tool:1");
    assert_eq!(request.operation_id, "capability:10:provider:2:tool:1");
}

#[tokio::test]
async fn refusal_commit_failure_prevents_continuation_and_duplicate_settlement() {
    struct FullDisk;
    impl EventSinkPort for FullDisk {
        type Error = std::io::Error;
        async fn append(&mut self, _: EngineEvent<'_>) -> Result<(), Self::Error> {
            Err(std::io::Error::other("disk full"))
        }
        async fn commit_terminal(&mut self, _: TerminalRecord<'_>) -> Result<(), Self::Error> {
            Err(std::io::Error::other("disk full"))
        }
    }
    let call = tool_call();
    let mut provider = FakeProvider::new([ProviderEvent::ToolCall(call.clone())]);
    let mut authority = FakeAuthority::default();
    let mut events = FakeEvents::default();
    let mut clock = FixedClock(100);
    let mut engine = TurnEngine::new(limits());
    engine
        .run(
            input(),
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .unwrap();
    let batch = engine.capability_batch().unwrap();
    let rejection = CapabilityRejection {
        decision_id: "deny:1".into(),
        reason_code: "user_denied".into(),
        policy_version: "policy:1".into(),
        decided_at_unix_ms: 100,
    };
    assert!(
        batch
            .refuse(
                &call,
                &rejection,
                1_000,
                &mut authority,
                &mut FullDisk,
                &mut clock
            )
            .await
            .is_err()
    );
    assert!(
        batch
            .refuse(
                &call,
                &rejection,
                1_000,
                &mut authority,
                &mut events,
                &mut clock
            )
            .await
            .is_err()
    );
    assert!(engine.finish_capability_batch(batch).is_err());
    assert_eq!(engine.state(), RunState::CapabilityDispatch);
    assert!(events.capability_lifecycle.is_empty());
}

#[tokio::test]
async fn provider_eof_is_a_durable_failure_and_never_success() {
    let (result, state, events) = run([]).await;

    assert_eq!(
        result,
        TurnOutcome::Failed {
            reason_code: "unexpected_provider_eof",
        }
    );
    assert_eq!(state, RunState::Failed);
    assert_eq!(
        events.terminal,
        Some((
            TerminalClassification::Failed,
            "unexpected_provider_eof".to_owned()
        ))
    );
}

#[tokio::test]
async fn response_byte_limit_interrupts_before_retaining_more_text() {
    let mut provider = FakeProvider::new([
        ProviderEvent::TextDelta("12345".to_owned()),
        ProviderEvent::TextDelta("6".to_owned()),
    ]);
    let mut authority = FakeAuthority::default();
    let mut events = FakeEvents::default();
    let mut clock = FixedClock(100);
    let mut engine = TurnEngine::new(EngineLimits::new(64, 8, 5, 5, 10, 100).expect("limits"));

    let result = engine
        .run(
            input(),
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .expect("bounded terminal");

    assert_eq!(
        result,
        TurnOutcome::Interrupted {
            reason_code: "response_bytes_exceeded",
        }
    );
    assert_eq!(engine.state(), RunState::Interrupted);
    assert_eq!(events.deltas, vec!["12345".to_owned()]);
}

#[tokio::test]
async fn complete_tool_call_stops_at_a_typed_capability_boundary() {
    let call = tool_call();
    let (result, state, events) = run([ProviderEvent::ToolCall(call.clone())]).await;

    assert_eq!(
        result,
        TurnOutcome::CapabilityRequired {
            call,
            assistant_text: String::new(),
            assistant_thinking: String::new(),
            usage: None,
        }
    );
    assert_eq!(state, RunState::CapabilityDispatch);
    assert_eq!(events.boundaries, vec!["tool:1".to_owned()]);
    assert_eq!(events.terminal, None);
}

#[tokio::test]
async fn capability_prepare_revalidates_authority_without_dispatching_an_effect() {
    let call = tool_call();
    let mut provider = FakeProvider::new([ProviderEvent::ToolCall(call.clone())]);
    let mut authority = FakeAuthority::default();
    let mut events = FakeEvents::default();
    let mut clock = FixedClock(100);
    let mut engine = TurnEngine::new(limits());
    let outcome = engine
        .run(
            input(),
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .expect("tool boundary");
    assert_eq!(
        outcome,
        TurnOutcome::CapabilityRequired {
            call: call.clone(),
            assistant_text: String::new(),
            assistant_thinking: String::new(),
            usage: None,
        }
    );
    let mut capabilities = FakeCapabilities::default();

    let decision = engine
        .prepare_capability(&call, [9; 32], 1_000, &mut capabilities, &mut authority)
        .await
        .expect("pre-dispatch decision");

    assert!(matches!(decision, CapabilityDecision::Rejected(_)));
    let request = capabilities.request.expect("capability invocation");
    assert_eq!(request.operation_id, "capability:10:provider:1:tool:1");
    assert_eq!(request.capability_id, "filesystem.read");
    assert_eq!(request.capability_set_sha256, [9; 32]);
    assert_eq!(
        authority.checkpoints.last(),
        Some(&AuthorityCheckpoint::CapabilityPrepare)
    );
    assert_eq!(engine.state(), RunState::CapabilityDispatch);
}

#[tokio::test]
async fn accepted_capability_commits_started_and_terminal_around_one_effect() {
    let call = tool_call();
    let mut provider = FakeProvider::new([ProviderEvent::ToolCall(call.clone())]);
    let mut authority = FakeAuthority::default();
    let mut events = FakeEvents::default();
    let mut clock = FixedClock(100);
    let mut engine = TurnEngine::new(limits());
    engine
        .run(
            input(),
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .expect("tool boundary");
    let mut executor = FakeExecutor::default();

    let outcome = engine
        .execute_capability(
            &call,
            [9; 32],
            1_000,
            &grant(),
            &mut executor,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .expect("capability lifecycle");

    assert!(matches!(outcome, CapabilityExecutionOutcome::Succeeded(_)));
    assert_eq!(executor.calls, 1);
    assert_eq!(events.capability_lifecycle, ["started", "succeeded"]);
    assert_eq!(engine.state(), RunState::Composing);
    assert_eq!(
        &authority.checkpoints[authority.checkpoints.len() - 2..],
        [
            AuthorityCheckpoint::CapabilityDispatch,
            AuthorityCheckpoint::CapabilityEffect,
        ]
    );
}

#[tokio::test]
async fn batch_members_are_exact_and_single_use_before_effect() {
    let call = tool_call();
    let mut provider = FakeProvider::new([ProviderEvent::ToolCall(call.clone())]);
    let mut authority = FakeAuthority::default();
    let mut events = FakeEvents::default();
    let mut clock = FixedClock(100);
    let mut engine = TurnEngine::new(limits());
    engine
        .run(
            input(),
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .unwrap();
    let batch = engine.capability_batch().unwrap();
    assert!(engine.capability_batch().is_err());
    let mut executor = FakeExecutor::default();
    let mut altered = call.clone();
    altered.parallel_safe = !altered.parallel_safe;
    assert!(
        batch
            .execute(
                &altered,
                [9; 32],
                1_000,
                &grant(),
                &mut executor,
                &mut authority,
                &mut events,
                &mut clock
            )
            .await
            .is_err()
    );
    batch
        .execute(
            &call,
            [9; 32],
            1_000,
            &grant(),
            &mut executor,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .unwrap();
    assert!(
        batch
            .execute(
                &call,
                [9; 32],
                1_000,
                &grant(),
                &mut executor,
                &mut authority,
                &mut events,
                &mut clock
            )
            .await
            .is_err()
    );
    assert_eq!(executor.calls, 1);
    assert_eq!(events.capability_lifecycle, ["started", "succeeded"]);
    engine.finish_capability_batch(batch).unwrap();
}

#[tokio::test]
async fn batch_cannot_finish_before_every_result_commits() {
    let mut provider = FakeProvider::new([ProviderEvent::ToolCall(tool_call())]);
    let mut authority = FakeAuthority::default();
    let mut events = FakeEvents::default();
    let mut clock = FixedClock(100);
    let mut engine = TurnEngine::new(limits());
    engine
        .run(
            input(),
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .unwrap();
    let batch = engine.capability_batch().unwrap();
    assert!(
        engine
            .pause_at_turn_limit(&mut authority, &mut events)
            .await
            .is_err()
    );
    assert!(events.terminal.is_none());
    assert!(engine.finish_capability_batch(batch).is_err());
    assert_eq!(engine.state(), RunState::CapabilityDispatch);
    assert!(engine.capability_batch().is_err());
}

#[tokio::test]
async fn authority_revocation_after_started_skips_effect_and_commits_cancelled() {
    let call = tool_call();
    let mut provider = FakeProvider::new([ProviderEvent::ToolCall(call.clone())]);
    let mut authority = FakeAuthority::default();
    let mut events = FakeEvents::default();
    let mut clock = FixedClock(100);
    let mut engine = TurnEngine::new(limits());
    engine
        .run(
            input(),
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .expect("tool boundary");
    authority.reject_effect = true;
    let mut executor = FakeExecutor::default();

    let outcome = engine
        .execute_capability(
            &call,
            [9; 32],
            1_000,
            &grant(),
            &mut executor,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .expect("durable cancellation");

    assert!(matches!(outcome, CapabilityExecutionOutcome::Cancelled(_)));
    assert_eq!(executor.calls, 0);
    assert_eq!(events.capability_lifecycle, ["started", "cancelled"]);
    assert_eq!(engine.state(), RunState::Composing);
}

#[tokio::test]
async fn executor_failure_after_started_commits_unknown_without_retry() {
    let call = tool_call();
    let mut provider = FakeProvider::new([ProviderEvent::ToolCall(call.clone())]);
    let mut authority = FakeAuthority::default();
    let mut events = FakeEvents::default();
    let mut clock = FixedClock(100);
    let mut engine = TurnEngine::new(limits());
    engine
        .run(
            input(),
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .expect("tool boundary");
    let mut executor = AmbiguousExecutor::default();

    let outcome = engine
        .execute_capability(
            &call,
            [9; 32],
            1_000,
            &grant(),
            &mut executor,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .expect("durable unknown terminal");

    assert!(matches!(
        outcome,
        CapabilityExecutionOutcome::OutcomeUnknown(CapabilityFailure {
            ref reason_code,
            duration_ms: 0,
        }) if reason_code == "executor_result_ambiguous"
    ));
    assert_eq!(executor.calls, 1);
    assert_eq!(events.capability_lifecycle, ["started", "outcome_unknown"]);
    assert_eq!(engine.state(), RunState::Composing);
}

#[tokio::test]
async fn interrupted_batch_commits_terminal_without_starting_remaining_members() {
    let first = tool_call();
    let mut second = first.clone();
    second.tool_use_id = OperationId::new("unstarted-tool").unwrap();
    let mut provider = FakeProvider::new([
        ProviderEvent::ToolCall(first.clone()),
        ProviderEvent::ToolCall(second),
    ]);
    let mut authority = FakeAuthority::default();
    let mut events = FakeEvents::default();
    let mut clock = FixedClock(100);
    let mut engine = TurnEngine::new(limits());
    engine
        .run(
            input(),
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .unwrap();
    let batch = engine.capability_batch().unwrap();
    let mut executor = AmbiguousExecutor::default();
    batch
        .execute(
            &first,
            [9; 32],
            1_000,
            &grant(),
            &mut executor,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .unwrap();
    engine
        .interrupt_capability_batch(batch, &mut events)
        .await
        .unwrap();
    assert_eq!(executor.calls, 1);
    assert_eq!(engine.state(), RunState::Interrupted);
    assert_eq!(
        events.terminal,
        Some((
            TerminalClassification::Interrupted,
            "capability_execution_interrupted".into()
        ))
    );
    assert!(engine.capability_batch().is_err());
}

#[tokio::test]
async fn capability_result_returns_engine_to_a_second_provider_turn() {
    let call = tool_call();
    let mut provider = FakeProvider::new([ProviderEvent::ToolCall(call.clone())]);
    let mut authority = FakeAuthority::default();
    let mut events = FakeEvents::default();
    let mut clock = FixedClock(100);
    let mut engine = TurnEngine::new(limits());
    engine
        .run(
            input(),
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .expect("tool boundary");
    let mut executor = FakeExecutor::default();
    engine
        .execute_capability(
            &call,
            [9; 32],
            1_000,
            &grant(),
            &mut executor,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .expect("capability terminal");
    let mut resumed_provider = FakeProvider::new([ProviderEvent::Completed {
        response_id: Some("response:resumed".into()),
        response_message_count: Some(3),
    }]);

    let outcome = engine
        .resume_after_capability(
            TurnInput {
                operation_id: operation("provider:2"),
                encoded_context: b"resumed-context".to_vec().into(),
                deadline_at_unix_ms: 1_000,
            },
            &mut resumed_provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .expect("resumed provider turn");

    assert_eq!(
        outcome,
        TurnOutcome::Completed {
            response_id: Some("response:resumed".into()),
            text: String::new(),
            usage: None,
        }
    );
    assert_eq!(engine.state(), RunState::Completed);
    assert_eq!(
        resumed_provider
            .request
            .expect("second provider request")
            .encoded_context
            .as_ref(),
        b"resumed-context",
    );
}

#[tokio::test]
async fn cumulative_usage_cannot_regress_or_cross_budget() {
    let (regressed, state, _) = run([
        ProviderEvent::Usage(usage(10, 2, 2)),
        ProviderEvent::Usage(usage(9, 2, 2)),
    ])
    .await;
    assert_eq!(
        regressed,
        TurnOutcome::Failed {
            reason_code: "invalid_provider_usage",
        }
    );
    assert_eq!(state, RunState::Failed);

    let (exceeded, state, _) = run([ProviderEvent::Usage(usage(10, 11, 2))]).await;
    assert_eq!(
        exceeded,
        TurnOutcome::Interrupted {
            reason_code: "provider_budget_exceeded",
        }
    );
    assert_eq!(state, RunState::Interrupted);
}

#[tokio::test]
async fn thinking_and_provider_cancellation_remain_distinct_from_public_text_and_failure() {
    let (result, state, events) = run([
        ProviderEvent::ThinkingDelta("thinking".to_owned()),
        ProviderEvent::Interrupted {
            reason_code: "cancelled".to_owned(),
        },
    ])
    .await;

    assert_eq!(
        result,
        TurnOutcome::Interrupted {
            reason_code: "provider_interrupted",
        }
    );
    assert_eq!(state, RunState::Interrupted);
    assert!(events.deltas.is_empty());
    assert_eq!(events.thinking, vec!["thinking".to_owned()]);
}

#[tokio::test]
async fn thinking_survives_a_tool_boundary_and_has_a_cumulative_byte_limit() {
    let (outcome, _, events) = run([
        ProviderEvent::ThinkingDelta("inspect ".into()),
        ProviderEvent::ThinkingDelta("first".into()),
        ProviderEvent::ToolCall(tool_call()),
    ])
    .await;
    let TurnOutcome::CapabilityRequired {
        assistant_text,
        assistant_thinking,
        ..
    } = outcome
    else {
        panic!("tool boundary expected");
    };
    assert!(assistant_text.is_empty());
    assert_eq!(assistant_thinking, "inspect first");
    assert!(events.deltas.is_empty());
    let (outcome, _, events) = run(std::array::from_fn::<_, 5, _>(|_| {
        ProviderEvent::ThinkingDelta("x".repeat(16))
    }))
    .await;
    assert_eq!(
        outcome,
        TurnOutcome::Interrupted {
            reason_code: "thinking_bytes_exceeded"
        }
    );
    assert_eq!(events.thinking.len(), 4);
}

async fn run<const N: usize>(
    provider_events: [ProviderEvent; N],
) -> (TurnOutcome, RunState, FakeEvents) {
    let mut provider = FakeProvider::new(provider_events);
    let mut authority = FakeAuthority::default();
    let mut events = FakeEvents::default();
    let mut clock = FixedClock(100);
    let mut engine = TurnEngine::new(limits());
    let outcome = engine
        .run(
            input(),
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .expect("semantic provider outcome");
    (outcome, engine.state(), events)
}

fn input() -> TurnInput {
    TurnInput {
        operation_id: operation("provider:1"),
        encoded_context: b"context".to_vec().into(),
        deadline_at_unix_ms: 1_000,
    }
}

fn limits() -> EngineLimits {
    EngineLimits::new(64, 16, 16, 64, 10, 100).expect("limits")
}

fn operation(value: &str) -> OperationId {
    OperationId::new(value).expect("operation ID")
}

fn tool_call() -> ProviderToolCall {
    ProviderToolCall {
        operation_id: operation("provider:1"),
        tool_use_id: operation("tool:1"),
        capability_name: "filesystem.read".to_owned(),
        capability_id: "filesystem.read".to_owned(),
        capability_version: "1".to_owned(),
        execution_class: ExecutionClass::NativeRead,
        mutates: false,
        parallel_safe: false,
        read_only: false,
        encoded_arguments: b"{}".to_vec(),
        arguments_sha256: [7; 32],
        provider_response_id: None,
        provider_response_message_count: None,
    }
}

fn grant() -> SealedExecutionGrant {
    SealedExecutionGrant {
        grant_id: "grant/1".into(),
        decision_id: "decision/1".into(),
        capability_id: "filesystem.read".into(),
        capability_version: "1".into(),
        operation_id: "capability:10:provider:1:tool:1".into(),
        tool_use_id: "tool:1".into(),
        effective_input_sha256: [7; 32],
        execution_class: ExecutionClass::NativeRead,
        mutates: false,
        environment_id: "environment/1".into(),
        environment_version: 1,
        workspace_lease_id: None,
        workspace_lease_version: None,
        workspace_fencing_epoch: None,
        resource_binding_id: "binding/1".into(),
        constraints_sha256: [8; 32],
        policy_version: "policy/v1".into(),
        nonce: vec![1; 16],
        issued_at_unix_ms: 50,
        expires_at_unix_ms: 500,
        native_filesystem_read: Some(NativeFilesystemReadBinding {
            canonical_root_path: "C:\\workspace".into(),
            max_read_bytes: 4_096,
            max_output_bytes: 8_192,
            require_utf8: true,
        }),
    }
}

const fn usage(input: u64, output: u64, cost: u64) -> ProviderUsage {
    ProviderUsage {
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: 0,
        cost_micros: cost,
    }
}

struct FakeProvider {
    events: VecDeque<ProviderEvent>,
    request: Option<ProviderRequest>,
}

impl FakeProvider {
    fn new(events: impl IntoIterator<Item = ProviderEvent>) -> Self {
        Self {
            events: events.into_iter().collect(),
            request: None,
        }
    }
}

impl ProviderGatewayPort for FakeProvider {
    type Operation = ();
    type Error = Infallible;

    fn start(
        &mut self,
        request: ProviderRequest,
    ) -> impl Future<Output = Result<Self::Operation, Self::Error>> + Send {
        self.request = Some(request);
        ready(Ok(()))
    }

    fn next(
        &mut self,
        _operation: &mut Self::Operation,
    ) -> impl Future<Output = Result<Option<ProviderEvent>, Self::Error>> + Send {
        ready(Ok(self.events.pop_front()))
    }
}

#[derive(Default)]
struct FakeCapabilities {
    request: Option<CapabilityInvocation>,
}

impl CapabilityGatewayPort for FakeCapabilities {
    type Error = Infallible;

    fn prepare(
        &mut self,
        invocation: CapabilityInvocation,
    ) -> impl Future<Output = Result<CapabilityDecision, Self::Error>> + Send {
        self.request = Some(invocation);
        ready(Ok(CapabilityDecision::Rejected(CapabilityRejection {
            decision_id: "decision/1".into(),
            reason_code: "policy_denied".into(),
            policy_version: "policy/v1".into(),
            decided_at_unix_ms: 100,
        })))
    }
}

#[derive(Debug, Default)]
struct FakeAuthority {
    checkpoints: Vec<AuthorityCheckpoint>,
    reject_effect: bool,
}

#[derive(Debug)]
struct FakeAuthorityError;

impl Display for FakeAuthorityError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("authority revoked")
    }
}

impl Error for FakeAuthorityError {}

impl AuthorityPort for FakeAuthority {
    type Error = FakeAuthorityError;

    fn verify(
        &mut self,
        checkpoint: AuthorityCheckpoint,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        self.checkpoints.push(checkpoint);
        ready(
            if self.reject_effect && checkpoint == AuthorityCheckpoint::CapabilityEffect {
                Err(FakeAuthorityError)
            } else {
                Ok(())
            },
        )
    }
}

#[derive(Default)]
struct FakeExecutor {
    calls: usize,
}

#[derive(Default)]
struct AmbiguousExecutor {
    calls: usize,
}

#[derive(Debug)]
struct AmbiguousExecutorError;

impl Display for AmbiguousExecutorError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("executor result transport was lost")
    }
}

impl Error for AmbiguousExecutorError {}

impl CapabilityExecutorPort for AmbiguousExecutor {
    type Error = AmbiguousExecutorError;

    fn execute(
        &mut self,
        _invocation: &CapabilityInvocation,
        _grant: &SealedExecutionGrant,
    ) -> impl Future<Output = Result<CapabilityExecutionOutcome, Self::Error>> + Send {
        self.calls += 1;
        ready(Err(AmbiguousExecutorError))
    }
}

impl CapabilityExecutorPort for FakeExecutor {
    type Error = Infallible;

    fn execute(
        &mut self,
        _invocation: &CapabilityInvocation,
        _grant: &SealedExecutionGrant,
    ) -> impl Future<Output = Result<CapabilityExecutionOutcome, Self::Error>> + Send {
        self.calls += 1;
        ready(Ok(CapabilityExecutionOutcome::Succeeded(
            CapabilityOutput {
                schema_id: "test.result".into(),
                schema_version: 1,
                encoded_result: b"result".to_vec(),
                result_sha256: [5; 32],
                bytes_read: 6,
                bytes_emitted: 6,
                truncated: false,
                duration_ms: 2,
            },
        )))
    }
}

#[derive(Default)]
struct FakeEvents {
    deltas: Vec<String>,
    thinking: Vec<String>,
    boundaries: Vec<String>,
    capability_lifecycle: Vec<&'static str>,
    terminal: Option<(TerminalClassification, String)>,
}

impl EventSinkPort for FakeEvents {
    type Error = Infallible;

    fn append(
        &mut self,
        event: EngineEvent<'_>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        match event {
            EngineEvent::ProviderDelta { text, .. } => self.deltas.push(text.to_owned()),
            EngineEvent::ProviderThinkingDelta { text, .. } => {
                self.thinking.push(text.to_owned());
            }
            EngineEvent::CapabilityBoundary { tool_use_id, .. } => {
                self.boundaries.push(tool_use_id.to_owned());
            }
            EngineEvent::CapabilityDispatchStarted { .. } => {
                self.capability_lifecycle.push("started");
            }
            EngineEvent::CapabilityRefused { .. } => self.capability_lifecycle.push("refused"),
            EngineEvent::CapabilityTerminal { outcome, .. } => {
                self.capability_lifecycle.push(match outcome {
                    CapabilityExecutionOutcome::Succeeded(_) => "succeeded",
                    CapabilityExecutionOutcome::Failed(CapabilityFailure { .. }) => "failed",
                    CapabilityExecutionOutcome::Cancelled(CapabilityFailure { .. }) => "cancelled",
                    CapabilityExecutionOutcome::OutcomeUnknown(CapabilityFailure { .. }) => {
                        "outcome_unknown"
                    }
                });
            }
            _ => {}
        }
        ready(Ok(()))
    }

    fn commit_terminal(
        &mut self,
        terminal: TerminalRecord<'_>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        self.terminal = Some((terminal.classification, terminal.reason_code.to_owned()));
        ready(Ok(()))
    }
}

struct FixedClock(i64);

impl ClockPort for FixedClock {
    type Error = Infallible;

    fn now_unix_ms(&mut self) -> impl Future<Output = Result<i64, Self::Error>> + Send {
        ready(Ok(self.0))
    }
}

#[tokio::test]
async fn events_received_after_execution_deadline_cannot_complete_or_start_tools() {
    struct DeadlineClock(u8);
    impl ClockPort for DeadlineClock {
        type Error = Infallible;
        fn now_unix_ms(&mut self) -> impl Future<Output = Result<i64, Self::Error>> + Send {
            self.0 += 1;
            ready(Ok(if self.0 <= 2 { 100 } else { 1_000 }))
        }
    }
    for event in [
        ProviderEvent::ToolCall(tool_call()),
        ProviderEvent::Completed {
            response_id: None,
            response_message_count: None,
        },
    ] {
        let mut engine = TurnEngine::new(limits());
        let mut provider = FakeProvider::new([event]);
        let mut events = FakeEvents::default();
        let outcome = engine
            .run(
                input(),
                &mut provider,
                &mut FakeAuthority::default(),
                &mut events,
                &mut DeadlineClock(0),
            )
            .await
            .expect("durable deadline");
        assert_eq!(
            outcome,
            TurnOutcome::Interrupted {
                reason_code: "deadline_exceeded"
            }
        );
        assert_eq!(engine.state(), RunState::Interrupted);
        assert_eq!(
            events.terminal,
            Some((
                TerminalClassification::Interrupted,
                "deadline_exceeded".into()
            ))
        );
    }
}
