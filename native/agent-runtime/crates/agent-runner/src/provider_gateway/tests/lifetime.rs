use std::convert::Infallible;
use std::time::Duration;

use agent_engine::limits::EngineLimits;
use agent_engine::operation::OperationId;
use agent_engine::ports::{AuthorityCheckpoint, AuthorityPort, ClockPort};
use agent_engine::turn::{TurnEngine, TurnInput, TurnOutcome};
use agent_protocol::frame::{AsyncEstablishedAttemptChannel, FrameReceiveOutcome};
use agent_protocol::generated::v1 as wire;
use agent_protocol::testing::established_data_duplex;
use prost::Message;
use tokio::time::Instant;

use super::super::ProviderDataGateway;
use crate::provider_data::{IDENTITY_BUDGET_REASON, ProviderDataTiming};

#[tokio::test]
async fn identity_budget_preserves_a_durable_terminal_and_never_opens_a_new_stream_at_the_limit() {
    for before_start in [false, true] {
        for corrupt_receipt in [false, true] {
            let identity = super::identity();
            let (runner, host) = established_data_duplex(&identity).unwrap();
            let mut provider = ProviderDataGateway::new(
                runner,
                identity.clone(),
                "runtime/budget".into(),
                wire::ProviderBinding {
                    effective_provider: "fixture".into(),
                    effective_model: "model".into(),
                    ..Default::default()
                },
                ProviderDataTiming {
                    settlement_deadline_at_unix_ms: 2_000,
                    hard_deadline: deadline(),
                    replay_write_timeout: Duration::from_secs(1),
                },
                || 10,
                64 * 1024,
            )
            .unwrap();
            // The test channel tracks 64 identities, including bootstrap.
            provider.identity_reserve = Some(if before_start { 63 } else { 61 });
            let mut events = provider.event_sink(2_000, 1).unwrap();
            let mut engine = TurnEngine::new(
                EngineLimits::new(64 * 1024, 64, 64 * 1024, 64 * 1024, 1000, 1000).unwrap(),
            );
            let mut authority = Authority;
            let mut clock = Clock;
            let run = engine.run(
                TurnInput {
                    operation_id: OperationId::new("provider/budget").unwrap(),
                    encoded_context: wire::ProviderTurnContext {
                        system: Some(wire::ProviderTextContent {
                            body: Some(wire::provider_text_content::Body::InlineUtf8(
                                "task".into(),
                            )),
                        }),
                        ..Default::default()
                    }
                    .encode_to_vec()
                    .into(),
                    deadline_at_unix_ms: 1000,
                },
                &mut provider,
                &mut authority,
                &mut events,
                &mut clock,
            );
            let (facts, result) =
                tokio::join!(serve(host, identity, before_start, corrupt_receipt), run);
            assert_eq!(facts.starts, usize::from(!before_start));
            assert_eq!(facts.checkpoints, usize::from(before_start));
            assert_eq!(facts.cancellations, usize::from(!before_start));
            assert!(
                facts.remaining > 0,
                "terminal must commit before channel exhaustion"
            );
            if corrupt_receipt {
                assert!(result.is_err());
            } else {
                assert_eq!(
                    result.unwrap(),
                    TurnOutcome::Interrupted {
                        reason_code: IDENTITY_BUDGET_REASON
                    }
                );
            }
        }
    }
}

#[derive(Default)]
struct Facts {
    starts: usize,
    checkpoints: usize,
    cancellations: usize,
    remaining: usize,
}

#[allow(clippy::too_many_lines)] // One sequential authenticated protocol fixture.
async fn serve(
    mut host: AsyncEstablishedAttemptChannel<tokio::io::DuplexStream>,
    identity: wire::AttemptIdentity,
    before_start: bool,
    corrupt_receipt: bool,
) -> Facts {
    let mut facts = Facts::default();
    let mut records = 0;
    loop {
        let FrameReceiveOutcome::Pending(mut pending) = host
            .begin_receive(deadline(), deadline(), Duration::from_secs(1), || 10)
            .await
            .unwrap()
        else {
            panic!("fresh message required");
        };
        let (body, digest) = pending.take_body_and_digest().unwrap();
        let checkpoint = matches!(&body, wire::frame_payload::Body::ProviderCheckpoint(_));
        match body {
            wire::frame_payload::Body::ProviderStart(start)
            | wire::frame_payload::Body::ProviderCheckpoint(start) => {
                assert_eq!(checkpoint, before_start);
                if checkpoint {
                    facts.checkpoints += 1;
                } else {
                    facts.starts += 1;
                }
                let accepted = wire::ProviderAccepted {
                    identity: Some(identity.clone()),
                    runtime_instance_id: "runtime/budget".into(),
                    operation_id: start.operation_id.clone(),
                    request_payload_sha256: digest.to_vec(),
                    accepted_at_unix_ms: 10,
                };
                let body = if before_start {
                    wire::frame_payload::Body::ProviderCheckpointCommitted(accepted)
                } else {
                    wire::frame_payload::Body::ProviderAccepted(accepted)
                };
                host.commit_response(
                    *pending,
                    &wire::FramePayload { body: Some(body) },
                    1000,
                    deadline(),
                    || 10,
                )
                .await
                .unwrap();
                if !before_start {
                    host.send_new(
                        &wire::FramePayload {
                            body: Some(wire::frame_payload::Body::ProviderTextDelta(
                                wire::ProviderTextDelta {
                                    identity: Some(identity.clone()),
                                    operation_id: start.operation_id,
                                    event_sequence: 1,
                                    text: "buffered".into(),
                                    ..Default::default()
                                },
                            )),
                        },
                        1000,
                        deadline(),
                        || 10,
                    )
                    .await
                    .unwrap();
                }
            }
            wire::frame_payload::Body::ProviderCancel(cancel) => {
                assert!(!before_start);
                assert_eq!(cancel.reason_code, IDENTITY_BUDGET_REASON);
                facts.cancellations += 1;
                host.commit_accepted(*pending).unwrap();
                host.send_new(
                    &wire::FramePayload {
                        body: Some(wire::frame_payload::Body::ProviderTerminal(
                            wire::ProviderTerminal {
                                identity: Some(identity.clone()),
                                operation_id: cancel.operation_id,
                                event_sequence: 2,
                                classification: wire::ProviderTerminalClassification::Cancelled
                                    as i32,
                                reason_code: "provider_cancelled".into(),
                                completed_at_unix_ms: 10,
                                ..Default::default()
                            },
                        )),
                    },
                    1000,
                    deadline(),
                    || 10,
                )
                .await
                .unwrap();
            }
            wire::frame_payload::Body::ProviderEventConsumed(credit) => {
                assert_eq!(credit.event_sequence, 1);
                host.commit_accepted(*pending).unwrap();
            }
            wire::frame_payload::Body::EngineEventProposal(proposal) => {
                let record = proposal.record.unwrap();
                records += 1;
                assert_eq!(record.local_sequence, records);
                let terminal = match &record.body {
                    Some(wire::engine_event_record_v1::Body::Terminal(value)) => {
                        assert_eq!(value.reason_code, IDENTITY_BUDGET_REASON);
                        assert_eq!(
                            value.classification,
                            wire::EngineTerminalClassificationV1::Interrupted as i32
                        );
                        true
                    }
                    Some(wire::engine_event_record_v1::Body::ProviderStarted(_)) => false,
                    _ => panic!(
                        "no capability or buffered content may execute after the budget stop"
                    ),
                };
                let mut payload_sha256 = proposal.expected_payload_sha256;
                if terminal && corrupt_receipt {
                    payload_sha256[0] ^= 1;
                }
                let response = wire::EngineEventCommitted {
                    identity: Some(identity.clone()),
                    runtime_instance_id: "runtime/budget".into(),
                    local_sequence: records,
                    event_payload_sha256: payload_sha256.clone(),
                    commit_receipt: Some(wire::CommitSessionRecordReceipt {
                        session_id: identity.session_id.clone(),
                        operation_id: format!("event/{records}"),
                        global_sequence: records,
                        kind: wire::SessionRecordKind::LifecycleEvent as i32,
                        durability: if terminal {
                            wire::SessionDurabilityClass::Authoritative as i32
                        } else {
                            wire::SessionDurabilityClass::Durable as i32
                        },
                        previous_commit_sha256: vec![0; 32],
                        payload_sha256,
                        commit_sha256: vec![1; 32],
                        payload_bytes: record.encoded_len() as u64,
                        ..Default::default()
                    }),
                };
                host.commit_response(
                    *pending,
                    &wire::FramePayload {
                        body: Some(wire::frame_payload::Body::EngineEventCommitted(response)),
                    },
                    1000,
                    deadline(),
                    || 10,
                )
                .await
                .unwrap();
                if terminal {
                    facts.remaining = host.remaining_identity_capacity();
                    return facts;
                }
            }
            _ => panic!("unexpected budget protocol message"),
        }
    }
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
struct Authority;
impl AuthorityPort for Authority {
    type Error = Infallible;
    async fn verify(&mut self, _: AuthorityCheckpoint) -> Result<(), Self::Error> {
        Ok(())
    }
}
struct Clock;
impl ClockPort for Clock {
    type Error = Infallible;
    async fn now_unix_ms(&mut self) -> Result<i64, Self::Error> {
        Ok(10)
    }
}
