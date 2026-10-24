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
use agent_tools::capability::{CapabilityDecision, CapabilityExecutionOutcome};
use prost::Message;
use sha2::{Digest, Sha256};
use tokio::io::DuplexStream;
use tokio::time::Instant;

use super::super::ProviderDataGateway;
use crate::native_tools::NativeToolExecutor;
use crate::provider_context::compose_capability_result_context;
use crate::provider_data::ProviderDataTiming;

const RUNTIME_ID: &str = "runtime/provider-capability-duplex";

#[tokio::test]
async fn native_read_crosses_durable_lifecycle_and_resumes_provider() {
    let root = temp_root();
    std::fs::create_dir_all(&root).expect("temp root");
    std::fs::write(root.join("sample.txt"), b"hello from native read").expect("fixture");
    let root = std::fs::canonicalize(root).expect("canonical temp root");
    let identity = super::identity();
    let (runner, host) = established_data_duplex(&identity).expect("test data peers");
    let now = Arc::new(AtomicI64::new(20));
    let host_task = serve_capability_host(
        host,
        identity.clone(),
        root.to_string_lossy().into_owned(),
        Arc::clone(&now),
    );
    let runner_task = run_capability_runner(runner, identity, Arc::clone(&now));

    let (records, outcome) = tokio::join!(host_task, runner_task);
    let outcome = outcome.expect("runner lifecycle");

    assert!(matches!(outcome, TurnOutcome::Completed { .. }));
    assert_eq!(records.len(), 9);
    assert!(matches!(
        records[2].body,
        Some(wire::engine_event_record_v1::Body::CapabilityBoundary(_))
    ));
    assert!(matches!(
        records[3].body,
        Some(wire::engine_event_record_v1::Body::CapabilityDispatchStarted(_))
    ));
    assert!(matches!(
        records[5].body,
        Some(wire::engine_event_record_v1::Body::CapabilityTerminal(_))
    ));
    std::fs::remove_dir_all(root).expect("temp cleanup");
}

async fn run_capability_runner(
    runner: AsyncEstablishedAttemptChannel<DuplexStream>,
    identity: wire::AttemptIdentity,
    now: Arc<AtomicI64>,
) -> Result<TurnOutcome, &'static str> {
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
        timing(),
        move || provider_now.load(Ordering::SeqCst),
        64 * 1_024,
    )
    .map_err(|_| "provider gateway")?;
    let mut capabilities = provider
        .capability_gateway(&[9; 32], 64 * 1_024)
        .map_err(|_| "capability gateway")?;
    let mut events = provider.event_sink(1_000, 1).map_err(|_| "event sink")?;
    let mut engine = TurnEngine::new(
        EngineLimits::new(64 * 1_024, 32, 64 * 1_024, 64 * 1_024, 100, 1_000)
            .map_err(|_| "limits")?,
    );
    let mut authority = AllowAuthority;
    let mut clock = FixedClock(20);
    let initial = provider_context().encode_to_vec();
    let first = engine
        .run(
            TurnInput {
                operation_id: operation("provider-operation/1"),
                encoded_context: initial.clone().into(),
                deadline_at_unix_ms: 1_000,
            },
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .map_err(|_| "first provider turn")?;
    let TurnOutcome::CapabilityRequired {
        call,
        assistant_text,
        ..
    } = first
    else {
        return Err("tool call expected");
    };
    let decision = engine
        .prepare_capability(&call, [9; 32], 1_000, &mut capabilities, &mut authority)
        .await
        .map_err(|_| "capability prepare")?;
    let CapabilityDecision::Accepted(grant) = decision else {
        return Err("accepted grant expected");
    };
    let mut executor = NativeToolExecutor;
    let capability_outcome = engine
        .execute_capability(
            &call,
            [9; 32],
            1_000,
            &grant,
            &mut executor,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .map_err(|_| "capability execution")?;
    if !matches!(capability_outcome, CapabilityExecutionOutcome::Succeeded(_)) {
        return Err("native read failed");
    }
    let resumed = compose_capability_result_context(
        &initial,
        &call,
        assistant_text.as_str(),
        &capability_outcome,
        64 * 1_024,
    )
    .map_err(|_| "result context")?;
    engine
        .resume_after_capability(
            TurnInput {
                operation_id: operation("provider-operation/2"),
                encoded_context: resumed.into(),
                deadline_at_unix_ms: 1_000,
            },
            &mut provider,
            &mut authority,
            &mut events,
            &mut clock,
        )
        .await
        .map_err(|_| "resumed provider turn")
}

async fn serve_capability_host(
    mut host: AsyncEstablishedAttemptChannel<DuplexStream>,
    identity: wire::AttemptIdentity,
    root: String,
    now: Arc<AtomicI64>,
) -> Vec<wire::EngineEventRecordV1> {
    let first = accept_provider_start(&mut host, &identity, now.as_ref()).await;
    assert_eq!(first.operation_id, "provider-operation/1");
    let mut records = vec![commit_engine_event(&mut host, &identity, 1).await];
    host.send_new(
        &tool_call(&identity, first.operation_id.as_str()),
        1_000,
        deadline(),
        || 20,
    )
    .await
    .expect("tool event");
    accept_consumed(&mut host, first.operation_id.as_str()).await;
    host.send_new(
        &provider_terminal(&identity, first.operation_id.as_str(), 2, "response/1", 1),
        1_000,
        deadline(),
        || 20,
    )
    .await
    .expect("first terminal");
    records.push(commit_engine_event(&mut host, &identity, 2).await);
    records.push(commit_engine_event(&mut host, &identity, 3).await);
    accept_capability_prepare(&mut host, &identity, root, now.as_ref()).await;
    records.push(commit_engine_event(&mut host, &identity, 4).await);
    records.push(commit_engine_event(&mut host, &identity, 5).await);
    records.push(commit_engine_event(&mut host, &identity, 6).await);

    let second = accept_provider_start(&mut host, &identity, now.as_ref()).await;
    assert_eq!(second.operation_id, "provider-operation/2");
    assert_eq!(second.previous_response_id.as_deref(), Some("response/1"));
    assert_eq!(second.previous_response_message_count, Some(1));
    assert!(matches!(
        second
            .messages
            .last()
            .and_then(|message| message.content.first()),
        Some(wire::ProviderContentBlock {
            body: Some(wire::provider_content_block::Body::ToolResult(_)),
        })
    ));
    records.push(commit_engine_event(&mut host, &identity, 7).await);
    host.send_new(
        &provider_terminal(&identity, second.operation_id.as_str(), 1, "response/2", 3),
        1_000,
        deadline(),
        || 20,
    )
    .await
    .expect("second terminal");
    records.push(commit_engine_event(&mut host, &identity, 8).await);
    records.push(commit_engine_event(&mut host, &identity, 9).await);
    records
}

async fn accept_provider_start(
    host: &mut AsyncEstablishedAttemptChannel<DuplexStream>,
    identity: &wire::AttemptIdentity,
    now: &AtomicI64,
) -> wire::ProviderStart {
    let FrameReceiveOutcome::Pending(mut pending) = host
        .begin_receive(deadline(), deadline(), Duration::from_secs(1), || {
            now.load(Ordering::SeqCst)
        })
        .await
        .expect("provider start")
    else {
        panic!("fresh provider start expected");
    };
    let (body, digest) = pending.take_body_and_digest().expect("start body");
    let wire::frame_payload::Body::ProviderStart(start) = body else {
        panic!("ProviderStart expected");
    };
    let response = wire::FramePayload {
        body: Some(wire::frame_payload::Body::ProviderAccepted(
            wire::ProviderAccepted {
                identity: Some(identity.clone()),
                runtime_instance_id: RUNTIME_ID.into(),
                operation_id: start.operation_id.clone(),
                request_payload_sha256: digest.to_vec(),
                accepted_at_unix_ms: 20,
            },
        )),
    };
    host.commit_response(*pending, &response, 1_000, deadline(), || 20)
        .await
        .expect("accepted response");
    start
}

async fn accept_capability_prepare(
    host: &mut AsyncEstablishedAttemptChannel<DuplexStream>,
    identity: &wire::AttemptIdentity,
    root: String,
    now: &AtomicI64,
) {
    let FrameReceiveOutcome::Pending(mut pending) = host
        .begin_receive(deadline(), deadline(), Duration::from_secs(1), || {
            now.load(Ordering::SeqCst)
        })
        .await
        .expect("capability prepare")
    else {
        panic!("fresh capability prepare expected");
    };
    let (body, _) = pending.take_body_and_digest().expect("prepare body");
    let wire::frame_payload::Body::CapabilityPrepare(prepare) = body else {
        panic!("CapabilityPrepare expected");
    };
    let binding = wire::NativeFilesystemReadBinding {
        canonical_root_path: root,
        max_read_bytes: 4_096,
        max_output_bytes: 8_192,
        require_utf8: true,
    };
    let response = wire::FramePayload {
        body: Some(wire::frame_payload::Body::CapabilityUpdate(
            wire::CapabilityUpdate {
                identity: Some(identity.clone()),
                runtime_instance_id: RUNTIME_ID.into(),
                operation_id: prepare.operation_id.clone(),
                tool_use_id: prepare.tool_use_id.clone(),
                decision: Some(wire::capability_update::Decision::Accepted(
                    wire::SealedExecutionGrant {
                        grant_id: "grant/1".into(),
                        decision_id: "decision/1".into(),
                        capability_id: prepare.capability_id,
                        capability_version: prepare.capability_version,
                        operation_id: prepare.operation_id,
                        tool_use_id: prepare.tool_use_id,
                        effective_input_sha256: prepare.input_sha256,
                        execution_class: prepare.execution_class,
                        mutates: false,
                        environment_id: "environment/local".into(),
                        environment_version: 1,
                        resource_binding_id: "binding/1".into(),
                        constraints_sha256: Sha256::digest(binding.encode_to_vec()).to_vec(),
                        policy_version: "policy/v1".into(),
                        nonce: vec![7; 32],
                        issued_at_unix_ms: 20,
                        expires_at_unix_ms: 900,
                        native_filesystem_read: Some(binding),
                        ..wire::SealedExecutionGrant::default()
                    },
                )),
            },
        )),
    };
    host.commit_response(*pending, &response, 1_000, deadline(), || 20)
        .await
        .expect("capability accepted");
}

async fn commit_engine_event(
    host: &mut AsyncEstablishedAttemptChannel<DuplexStream>,
    identity: &wire::AttemptIdentity,
    sequence: u64,
) -> wire::EngineEventRecordV1 {
    let FrameReceiveOutcome::Pending(mut pending) = host
        .begin_receive(deadline(), deadline(), Duration::from_secs(1), || 20)
        .await
        .expect("engine proposal")
    else {
        panic!("fresh engine proposal expected");
    };
    let (body, _) = pending.take_body_and_digest().expect("proposal body");
    let wire::frame_payload::Body::EngineEventProposal(proposal) = body else {
        panic!("EngineEventProposal expected");
    };
    let record = proposal.record.expect("engine record");
    assert_eq!(record.local_sequence, sequence);
    let encoded = record.encode_to_vec();
    let response = wire::FramePayload {
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
                    kind: match &record.body {
                        Some(wire::engine_event_record_v1::Body::Content(content)) => {
                            if content.kind == wire::EngineContentKindV1::ToolInput as i32 {
                                wire::SessionRecordKind::Input as i32
                            } else {
                                wire::SessionRecordKind::ToolOutput as i32
                            }
                        }
                        _ => wire::SessionRecordKind::LifecycleEvent as i32,
                    },
                    durability: event_durability(&record),
                    previous_commit_sha256: vec![0; 32],
                    payload_sha256: proposal.expected_payload_sha256,
                    commit_sha256: vec![u8::try_from(sequence).unwrap_or_default(); 32],
                    payload_bytes: u64::try_from(encoded.len()).expect("payload length"),
                    ..wire::CommitSessionRecordReceipt::default()
                }),
            },
        )),
    };
    host.commit_response(*pending, &response, 1_000, deadline(), || 20)
        .await
        .expect("engine committed response");
    record
}

fn provider_context() -> wire::ProviderTurnContext {
    let schema =
        br#"{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}"#;
    wire::ProviderTurnContext {
        tools: vec![wire::ProviderToolDescriptor {
            capability_name: "read_file".into(),
            description: "Read one UTF-8 file".into(),
            encoded_json_schema: schema.to_vec(),
            schema_sha256: Sha256::digest(schema).to_vec(),
            capability_id: "native.read_file".into(),
            capability_version: "1".into(),
            execution_class: wire::CapabilityExecutionClass::NativeRead as i32,
            mutates: false,
            parallel_safe: false,
            read_only: false,
        }],
        ..wire::ProviderTurnContext::default()
    }
}

fn tool_call(identity: &wire::AttemptIdentity, operation_id: &str) -> wire::FramePayload {
    let input = br#"{"path":"sample.txt"}"#;
    wire::FramePayload {
        body: Some(wire::frame_payload::Body::ProviderToolCall(
            wire::ProviderToolCall {
                identity: Some(identity.clone()),
                operation_id: operation_id.into(),
                event_sequence: 1,
                tool_use_id: "tool/1".into(),
                capability_name: "read_file".into(),
                encoded_json_arguments: input.to_vec(),
                arguments_sha256: Sha256::digest(input).to_vec(),
            },
        )),
    }
}

fn provider_terminal(
    identity: &wire::AttemptIdentity,
    operation_id: &str,
    sequence: u64,
    response_id: &str,
    message_count: u64,
) -> wire::FramePayload {
    wire::FramePayload {
        body: Some(wire::frame_payload::Body::ProviderTerminal(
            wire::ProviderTerminal {
                identity: Some(identity.clone()),
                operation_id: operation_id.into(),
                event_sequence: sequence,
                classification: wire::ProviderTerminalClassification::Completed as i32,
                reason_code: "provider_completed".into(),
                response_id: Some(response_id.into()),
                completed_at_unix_ms: 20,
                response_message_count: Some(message_count),
                ..wire::ProviderTerminal::default()
            },
        )),
    }
}

fn event_durability(record: &wire::EngineEventRecordV1) -> i32 {
    use wire::engine_event_record_v1::Body;
    match record.body.as_ref() {
        Some(Body::ProviderDelta(_)) => wire::SessionDurabilityClass::Coalesced as i32,
        Some(
            Body::Content(_)
            | Body::CapabilityBoundary(_)
            | Body::CapabilityDispatchStarted(_)
            | Body::CapabilityTerminal(_)
            | Body::Terminal(_),
        ) => wire::SessionDurabilityClass::Authoritative as i32,
        _ => wire::SessionDurabilityClass::Durable as i32,
    }
}

fn temp_root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "codestudio-capability-duplex-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos(),
    ))
}

fn operation(value: &str) -> OperationId {
    OperationId::new(value).expect("operation ID")
}

fn timing() -> ProviderDataTiming {
    ProviderDataTiming {
        settlement_deadline_at_unix_ms: 2_000,
        hard_deadline: deadline(),
        replay_write_timeout: Duration::from_secs(1),
    }
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
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

async fn accept_consumed(
    host: &mut AsyncEstablishedAttemptChannel<DuplexStream>,
    operation_id: &str,
) {
    let FrameReceiveOutcome::Pending(mut pending) = host
        .begin_receive(deadline(), deadline(), Duration::from_secs(1), || 20)
        .await
        .expect("consumption receipt")
    else {
        panic!("fresh receipt");
    };
    let (body, _) = pending.take_body_and_digest().expect("credit body");
    let wire::frame_payload::Body::ProviderEventConsumed(consumed) = body else {
        panic!("consumption expected");
    };
    assert_eq!(consumed.operation_id, operation_id);
    assert_eq!(consumed.event_sequence, 1);
    host.commit_accepted(*pending).expect("credit committed");
}
