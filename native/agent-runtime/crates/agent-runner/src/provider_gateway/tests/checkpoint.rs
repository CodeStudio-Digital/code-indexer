use super::super::ProviderDataGateway;
use crate::provider_data::ProviderDataTiming;
use agent_engine::operation::OperationId;
use agent_engine::ports::{ProviderFrontierPort, ProviderRequest};
use agent_protocol::frame::FrameReceiveOutcome;
use agent_protocol::generated::v1 as wire;
use agent_protocol::testing::established_data_duplex;
use prost::Message;
use std::time::Duration;
use tokio::time::Instant;

#[tokio::test]
async fn checkpoint_requires_its_exact_durable_receipt_and_opens_no_stream() {
    for mismatch in [false, true] {
        let identity = super::identity();
        let (runner, mut host) = established_data_duplex(&identity).unwrap();
        let timing = ProviderDataTiming {
            settlement_deadline_at_unix_ms: 2_000,
            hard_deadline: Instant::now() + Duration::from_secs(3),
            replay_write_timeout: Duration::from_secs(1),
        };
        let mut provider = ProviderDataGateway::new(
            runner,
            identity.clone(),
            "runtime/checkpoint".into(),
            wire::ProviderBinding {
                effective_provider: "fixture".into(),
                effective_model: "model".into(),
                ..Default::default()
            },
            timing,
            || 10,
            64 * 1024,
        )
        .unwrap();
        let context = wire::ProviderTurnContext {
            messages: vec![wire::ProviderMessage {
                role: wire::ProviderMessageRole::User as i32,
                content: vec![wire::ProviderContentBlock {
                    body: Some(wire::provider_content_block::Body::Text(
                        wire::ProviderTextContent {
                            body: Some(wire::provider_text_content::Body::InlineUtf8(
                                "task".into(),
                            )),
                        },
                    )),
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let checkpoint = provider.checkpoint(ProviderRequest {
            operation_id: OperationId::new("checkpoint/1").unwrap(),
            encoded_context: context.encode_to_vec().into(),
            deadline_at_unix_ms: 1000,
        });
        let host_reply = async {
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
                panic!("fresh checkpoint");
            };
            let (body, digest) = pending.take_body_and_digest().unwrap();
            let wire::frame_payload::Body::ProviderCheckpoint(start) = body else {
                panic!("provider must not start");
            };
            assert_eq!(start.messages, context.messages);
            let mut digest = digest.to_vec();
            if mismatch {
                digest[0] ^= 1;
            }
            let reply = wire::FramePayload {
                body: Some(wire::frame_payload::Body::ProviderCheckpointCommitted(
                    wire::ProviderAccepted {
                        identity: Some(identity),
                        runtime_instance_id: "runtime/checkpoint".into(),
                        operation_id: start.operation_id,
                        request_payload_sha256: digest,
                        accepted_at_unix_ms: 10,
                    },
                )),
            };
            host.commit_response(*pending, &reply, 1000, timing.hard_deadline, || 10)
                .await
                .unwrap();
        };
        let (result, ()) = tokio::join!(checkpoint, host_reply);
        assert_eq!(result.is_err(), mismatch);
    }
}
