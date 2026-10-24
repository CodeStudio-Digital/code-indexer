use super::*;
use agent_protocol::testing::established_data_duplex;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;
use tokio::time::Instant;

#[tokio::test]
async fn effect_deadline_does_not_expire_its_terminal_response_envelope() {
    let identity = crate::provider_data::tests::identity();
    let (runner, mut host) = established_data_duplex(&identity).unwrap();
    let runtime = "runtime/settlement";
    let mut client = ProviderDataClient::new(runner, identity.clone(), runtime.into());
    let timing = ProviderDataTiming {
        settlement_deadline_at_unix_ms: 2_000,
        hard_deadline: Instant::now() + Duration::from_secs(3),
        replay_write_timeout: Duration::from_secs(1),
    };
    let execute = wire::CapabilityExecute {
        identity: Some(identity.clone()),
        runtime_instance_id: runtime.into(),
        operation_id: "effect/1".into(),
        tool_use_id: "tool/1".into(),
        grant_id: "grant/1".into(),
        effective_input_sha256: vec![1; 32],
        deadline_at_unix_ms: 1_000,
    };
    let now = AtomicI64::new(100);
    let clock = || now.load(Ordering::SeqCst);
    let host_work = async {
        let FrameReceiveOutcome::Pending(mut pending) = host
            .begin_receive(
                timing.hard_deadline,
                timing.hard_deadline,
                Duration::from_secs(1),
                clock,
            )
            .await
            .unwrap()
        else {
            panic!("execute request");
        };
        assert_eq!(pending.header().deadline_at_unix_ms, Some(2_000));
        let (body, _) = pending.take_body_and_digest().unwrap();
        let wire::frame_payload::Body::CapabilityExecute(request) = body else {
            panic!("execute body");
        };
        assert_eq!(request.deadline_at_unix_ms, 1_000);
        now.store(1_001, Ordering::SeqCst);
        host.commit_response(
            *pending,
            &wire::FramePayload {
                body: Some(wire::frame_payload::Body::CapabilityExecutionResult(
                    wire::CapabilityExecutionResult {
                        identity: Some(identity.clone()),
                        runtime_instance_id: runtime.into(),
                        operation_id: request.operation_id,
                        tool_use_id: request.tool_use_id,
                        grant_id: request.grant_id,
                        outcome: Some(wire::capability_execution_result::Outcome::OutcomeUnknown(
                            wire::CapabilityExecutionFailure {
                                reason_code: "deadline_after_dispatch".into(),
                                duration_ms: 901,
                            },
                        )),
                    },
                )),
            },
            2_000,
            timing.hard_deadline,
            clock,
        )
        .await
        .unwrap();
    };
    let ((), result) = tokio::join!(
        host_work,
        client.execute_capability(execute, timing, &clock)
    );
    assert!(matches!(
        result.unwrap().outcome,
        Some(wire::capability_execution_result::Outcome::OutcomeUnknown(
            _
        ))
    ));
}
