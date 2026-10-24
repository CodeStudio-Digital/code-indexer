use std::convert::Infallible;
use std::future::{Future, ready};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use agent_engine::limits::EngineLimits;
use agent_engine::operation::OperationId;
use agent_engine::ports::{AuthorityCheckpoint, AuthorityPort, ClockPort};
use agent_engine::turn::{TurnEngine, TurnInput, TurnOutcome};
use agent_protocol::frame::{AsyncEstablishedAttemptChannel, FrameReceiveOutcome};
use agent_protocol::generated::v1 as wire;
use agent_protocol::testing::established_data_duplex;
use prost::Message;
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use tokio::time::Instant;

use super::super::ProviderDataGateway;
use crate::provider_data::ProviderDataTiming;

const RUNTIME_ID: &str = "runtime/provider-duplex";

#[tokio::test]
async fn established_duplex_runs_one_text_turn_through_the_engine() {
    let identity = super::identity();
    let (runner, host) = established_data_duplex(&identity).expect("test data peers");
    let now = Arc::new(AtomicI64::new(10));
    let host = serve_host(host, identity.clone(), Arc::clone(&now));

    let provider_now = Arc::clone(&now);
    let mut provider = ProviderDataGateway::new(
        runner,
        identity,
        RUNTIME_ID.into(),
        wire::ProviderBinding {
            effective_provider: "provider-v1".into(),
            effective_model: "model-v1".into(),
            ..wire::ProviderBinding::default()
        },
        ProviderDataTiming {
            settlement_deadline_at_unix_ms: 2_000,
            hard_deadline: deadline(),
            replay_write_timeout: Duration::from_secs(1),
        },
        move || provider_now.load(Ordering::SeqCst),
        64 * 1_024,
    )
    .expect("provider gateway");
    let (start_signal, started) = oneshot::channel();
    provider.signal_first_start_with(start_signal);
    let mut events = provider.event_sink(1_000, 1).expect("event sink");
    let mut engine = TurnEngine::new(
        EngineLimits::new(64 * 1_024, 16, 4 * 1_024, 64 * 1_024, 100, 1_000)
            .expect("engine limits"),
    );
    let mut authority = AllowAuthority;
    let mut clock = FixedClock(20);
    let engine_run = engine.run(
        TurnInput {
            operation_id: OperationId::new("provider-operation/1").expect("operation"),
            encoded_context: provider_context().encode_to_vec().into(),
            deadline_at_unix_ms: 1_000,
        },
        &mut provider,
        &mut authority,
        &mut events,
        &mut clock,
    );
    let (records, result, started) = tokio::join!(host, engine_run, started);
    let outcome = result.expect("engine turn");
    started.expect("physical ProviderStart barrier");

    assert_eq!(
        outcome,
        TurnOutcome::Completed {
            response_id: Some("response/duplex".into()),
            text: "hello from host".into(),
            usage: Some(agent_engine::ports::ProviderUsage {
                input_tokens: 8,
                output_tokens: 3,
                cached_input_tokens: 2,
                cost_micros: 7,
            }),
        }
    );
    assert_eq!(records.len(), 5);
    assert!(matches!(
        records[0].body,
        Some(wire::engine_event_record_v1::Body::ProviderStarted(_))
    ));
    assert!(matches!(
        records[4].body,
        Some(wire::engine_event_record_v1::Body::Terminal(_))
    ));
    assert_eq!(events.next_local_sequence(), 6);
    assert_eq!(
        events.last_receipt().map(|receipt| receipt.global_sequence),
        Some(5)
    );
}

#[allow(clippy::too_many_lines)] // One sequential physical protocol fixture.
async fn serve_host(
    mut host: AsyncEstablishedAttemptChannel<tokio::io::DuplexStream>,
    identity: wire::AttemptIdentity,
    now: Arc<AtomicI64>,
) -> Vec<wire::EngineEventRecordV1> {
    let FrameReceiveOutcome::Pending(mut pending) = host
        .begin_receive(deadline(), deadline(), Duration::from_secs(1), || {
            now.load(Ordering::SeqCst)
        })
        .await
        .expect("provider start")
    else {
        panic!("fresh provider start expected");
    };
    let (body, request_digest) = pending.take_body_and_digest().expect("start body");
    let wire::frame_payload::Body::ProviderStart(start) = body else {
        panic!("ProviderStart expected");
    };
    assert_eq!(start.identity.as_ref(), Some(&identity));
    assert_eq!(
        start.binding.as_ref().expect("binding").effective_model,
        "model-v1"
    );
    assert_eq!(start.deadline_at_unix_ms, 1_000);

    now.store(20, Ordering::SeqCst);
    let accepted = wire::FramePayload {
        body: Some(wire::frame_payload::Body::ProviderAccepted(
            wire::ProviderAccepted {
                identity: Some(identity.clone()),
                runtime_instance_id: RUNTIME_ID.into(),
                operation_id: start.operation_id.clone(),
                request_payload_sha256: request_digest.to_vec(),
                // Same-machine processes can observe a one-millisecond wall
                // clock inversion around the physical pipe write.
                accepted_at_unix_ms: 9,
            },
        )),
    };
    host.commit_response(*pending, &accepted, 1_000, deadline(), || 20)
        .await
        .expect("accepted response");
    host.send_new(
        &provider_text(&identity, start.operation_id.as_str()),
        1_000,
        deadline(),
        || 20,
    )
    .await
    .expect("text event");
    let mut records = Vec::new();
    while records.len() < 5 {
        let sequence = records.len() as u64 + 1;
        let FrameReceiveOutcome::Pending(mut pending) = host
            .begin_receive(deadline(), deadline(), Duration::from_secs(1), || 20)
            .await
            .expect("engine proposal")
        else {
            panic!("fresh engine proposal expected");
        };
        let (body, _) = pending.take_body_and_digest().expect("proposal body");
        if let wire::frame_payload::Body::ProviderEventConsumed(consumed) = &body {
            assert_eq!(consumed.operation_id, start.operation_id);
            assert_eq!(consumed.event_sequence, 1);
            assert_eq!(
                records.len(),
                1,
                "text buffered during ProviderStarted persistence is not consumed early"
            );
            host.commit_accepted(*pending).expect("credit receipt");
            host.send_new(
                &provider_terminal(&identity, start.operation_id.as_str()),
                1_000,
                deadline(),
                || 20,
            )
            .await
            .expect("terminal event");
            continue;
        }
        let wire::frame_payload::Body::EngineEventProposal(proposal) = body else {
            panic!("EngineEventProposal expected");
        };
        let record = proposal.record.expect("engine record");
        assert_eq!(record.local_sequence, sequence);
        let encoded = record.encode_to_vec();
        assert_eq!(
            Sha256::digest(&encoded).as_slice(),
            proposal.expected_payload_sha256
        );
        let committed = wire::FramePayload {
            body: Some(wire::frame_payload::Body::EngineEventCommitted(
                wire::EngineEventCommitted {
                    identity: Some(identity.clone()),
                    runtime_instance_id: RUNTIME_ID.into(),
                    local_sequence: sequence,
                    event_payload_sha256: proposal.expected_payload_sha256.clone(),
                    commit_receipt: Some(wire::CommitSessionRecordReceipt {
                        session_id: identity.session_id.clone(),
                        operation_id: format!("event/{sequence}"),
                        global_sequence: sequence,
                        kind: if matches!(
                            record.body,
                            Some(wire::engine_event_record_v1::Body::Content(_))
                        ) {
                            wire::SessionRecordKind::Conversation as i32
                        } else {
                            wire::SessionRecordKind::LifecycleEvent as i32
                        },
                        durability: event_durability(&record),
                        previous_commit_sha256: vec![0; 32],
                        payload_sha256: proposal.expected_payload_sha256,
                        commit_sha256: vec![u8::try_from(sequence).unwrap_or_default(); 32],
                        payload_bytes: encoded.len() as u64,
                        ..wire::CommitSessionRecordReceipt::default()
                    }),
                },
            )),
        };
        host.commit_response(*pending, &committed, 1_000, deadline(), || 20)
            .await
            .expect("engine committed response");
        records.push(record);
    }
    records
}

fn event_durability(record: &wire::EngineEventRecordV1) -> i32 {
    use wire::engine_event_record_v1::Body;
    match record.body.as_ref() {
        Some(Body::ProviderDelta(_) | Body::Content(_)) => {
            wire::SessionDurabilityClass::Coalesced as i32
        }
        Some(
            Body::CapabilityBoundary(_)
            | Body::CapabilityDispatchStarted(_)
            | Body::CapabilityTerminal(_)
            | Body::Terminal(_),
        ) => wire::SessionDurabilityClass::Authoritative as i32,
        _ => wire::SessionDurabilityClass::Durable as i32,
    }
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

fn provider_context() -> wire::ProviderTurnContext {
    wire::ProviderTurnContext {
        system: Some(wire::ProviderTextContent {
            body: Some(wire::provider_text_content::Body::InlineUtf8(
                "answer briefly".into(),
            )),
        }),
        ..wire::ProviderTurnContext::default()
    }
}

fn provider_text(identity: &wire::AttemptIdentity, operation_id: &str) -> wire::FramePayload {
    wire::FramePayload {
        body: Some(wire::frame_payload::Body::ProviderTextDelta(
            wire::ProviderTextDelta {
                identity: Some(identity.clone()),
                operation_id: operation_id.into(),
                event_sequence: 1,
                text: "hello from host".into(),
                ..wire::ProviderTextDelta::default()
            },
        )),
    }
}

fn provider_terminal(identity: &wire::AttemptIdentity, operation_id: &str) -> wire::FramePayload {
    wire::FramePayload {
        body: Some(wire::frame_payload::Body::ProviderTerminal(
            wire::ProviderTerminal {
                identity: Some(identity.clone()),
                operation_id: operation_id.into(),
                event_sequence: 2,
                classification: wire::ProviderTerminalClassification::Completed as i32,
                reason_code: "provider_completed".into(),
                response_id: Some("response/duplex".into()),
                final_usage: Some(wire::ProviderUsage {
                    input_tokens: 8,
                    output_tokens: 3,
                    cache_read_input_tokens: Some(2),
                    cost_micros: Some(7),
                    ..wire::ProviderUsage::default()
                }),
                completed_at_unix_ms: 20,
                response_message_count: None,
            },
        )),
    }
}

struct AllowAuthority;

impl AuthorityPort for AllowAuthority {
    type Error = Infallible;

    fn verify(
        &mut self,
        _checkpoint: AuthorityCheckpoint,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
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
