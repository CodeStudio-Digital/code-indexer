use super::*;
use crate::provider_data::tests::identity;
use agent_protocol::testing::established_data_duplex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::time::Instant;

#[tokio::test]
async fn chunk_refuses_foreign_receipt_and_stops_when_the_host_disconnects() {
    for disconnect in [false, true] {
        let identity = identity();
        let (runner, mut host) = established_data_duplex(&identity).unwrap();
        let mut client = ProviderDataClient::new(runner, identity.clone(), "runtime/chunks".into());
        let timing = ProviderDataTiming {
            settlement_deadline_at_unix_ms: 2_000,
            hard_deadline: Instant::now() + Duration::from_secs(2),
            replay_write_timeout: Duration::from_secs(1),
        };
        let start = wire::ProviderStart {
            identity: Some(identity.clone()),
            operation_id: "large/1".into(),
            system: Some(wire::ProviderTextContent {
                body: Some(wire::provider_text_content::Body::InlineUtf8(
                    "x".repeat(1200 * 1024),
                )),
            }),
            deadline_at_unix_ms: 1_000,
            ..Default::default()
        };
        let host_work = async move {
            let FrameReceiveOutcome::Pending(mut pending) = host
                .begin_receive(
                    timing.hard_deadline,
                    timing.hard_deadline,
                    timing.replay_write_timeout,
                    || 10,
                )
                .await
                .unwrap()
            else {
                panic!("first chunk");
            };
            let (body, digest) = pending.take_body_and_digest().unwrap();
            assert!(matches!(
                body,
                wire::frame_payload::Body::ProviderRequestChunk(_)
            ));
            if disconnect {
                return;
            }
            let accepted = wire::ProviderAccepted {
                identity: Some(identity),
                runtime_instance_id: "runtime/chunks".into(),
                operation_id: "FOREIGN".into(),
                request_payload_sha256: digest.to_vec(),
                accepted_at_unix_ms: 10,
            };
            host.commit_response(
                *pending,
                &wire::FramePayload {
                    body: Some(wire::frame_payload::Body::ProviderRequestChunkAccepted(
                        accepted,
                    )),
                },
                1_000,
                timing.hard_deadline,
                || 10,
            )
            .await
            .unwrap();
        };
        let ((), result) = tokio::join!(
            host_work,
            client.send_provider_request(start, false, timing, &|| 10, || {})
        );
        assert!(result.is_err());
    }
}

#[tokio::test]
async fn large_start_and_checkpoint_wait_for_each_authenticated_chunk_receipt() {
    for checkpoint in [false, true] {
        let identity = identity();
        let (runner, mut host) = established_data_duplex(&identity).unwrap();
        let mut client = ProviderDataClient::new(runner, identity.clone(), "runtime/chunks".into());
        let start = wire::ProviderStart {
            identity: Some(identity.clone()),
            operation_id: "large/1".into(),
            binding: Some(wire::ProviderBinding {
                effective_provider: "test".into(),
                effective_model: "test".into(),
                ..Default::default()
            }),
            system: Some(wire::ProviderTextContent {
                body: Some(wire::provider_text_content::Body::InlineUtf8(
                    "x".repeat(1200 * 1024),
                )),
            }),
            deadline_at_unix_ms: 1_000,
            idempotency_key: "start/1".into(),
            ..Default::default()
        };
        let expected = start.encode_to_vec();
        let notified = AtomicBool::new(false);
        let timing = ProviderDataTiming {
            settlement_deadline_at_unix_ms: 2_000,
            hard_deadline: Instant::now() + Duration::from_secs(5),
            replay_write_timeout: Duration::from_secs(1),
        };
        let host_work = receive_large_request(
            &mut host, &identity, &expected, &notified, checkpoint, timing,
        );
        let runner_work = async {
            if checkpoint {
                // Checkpoint has no activation notification; the test marks it
                // before sending so the same host validation can be reused.
                notified.store(true, Ordering::SeqCst);
                client.checkpoint(start, timing, &|| 10).await.unwrap();
            } else {
                client
                    .start_observed(start, timing, &|| 10, || {
                        notified.store(true, Ordering::SeqCst);
                    })
                    .await
                    .unwrap();
            }
        };
        tokio::join!(host_work, runner_work);
    }
}

async fn receive_large_request(
    host: &mut agent_protocol::frame::AsyncEstablishedAttemptChannel<tokio::io::DuplexStream>,
    identity: &wire::AttemptIdentity,
    expected: &[u8],
    notified: &AtomicBool,
    checkpoint: bool,
    timing: ProviderDataTiming,
) {
    let mut assembled = Vec::new();
    loop {
        let FrameReceiveOutcome::Pending(mut pending) = host
            .begin_receive(
                timing.hard_deadline,
                timing.hard_deadline,
                timing.replay_write_timeout,
                || 10,
            )
            .await
            .unwrap()
        else {
            panic!("fresh request");
        };
        let (body, digest) = pending.take_body_and_digest().unwrap();
        let (operation_id, request_digest, done) = match body {
            wire::frame_payload::Body::ProviderRequestChunk(chunk) => {
                assert!(notified.load(Ordering::SeqCst));
                assert_eq!(
                    usize::try_from(chunk.chunk_offset).unwrap(),
                    assembled.len()
                );
                assert_eq!(chunk.checkpoint_only, checkpoint);
                assert!(chunk.encoded_chunk.len() <= MAX_CHUNK_BYTES);
                assembled.extend_from_slice(&chunk.encoded_chunk);
                (chunk.operation_id, chunk.request_sha256, false)
            }
            wire::frame_payload::Body::ProviderRequestCommit(commit) => {
                assert_eq!(
                    usize::try_from(commit.total_bytes).unwrap(),
                    assembled.len()
                );
                assert_eq!(commit.checkpoint_only, checkpoint);
                (commit.operation_id, commit.request_sha256, true)
            }
            _ => panic!("only chunk transport expected"),
        };
        assert_eq!(request_digest, Sha256::digest(expected).to_vec());
        let accepted = wire::ProviderAccepted {
            identity: Some(identity.clone()),
            runtime_instance_id: "runtime/chunks".into(),
            operation_id,
            request_payload_sha256: digest.to_vec(),
            accepted_at_unix_ms: 10,
        };
        let body = if !done {
            wire::frame_payload::Body::ProviderRequestChunkAccepted(accepted)
        } else if checkpoint {
            wire::frame_payload::Body::ProviderCheckpointCommitted(accepted)
        } else {
            wire::frame_payload::Body::ProviderAccepted(accepted)
        };
        host.commit_response(
            *pending,
            &wire::FramePayload { body: Some(body) },
            1_000,
            timing.hard_deadline,
            || 10,
        )
        .await
        .unwrap();
        if done {
            assert_eq!(assembled, expected);
            break;
        }
    }
}
