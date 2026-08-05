use std::io::Cursor;

use agent_platform::ipc::endpoint_cancellation;
use agent_protocol::frame::CONTROL_FRAME_MAX_BYTES;
use agent_protocol::framing::DelimitedFrameCodec;
use agent_protocol::generated::v1 as wire;
use prost::Message;

use super::support::active;
use crate::control::active_lifetime::ActiveRunnerLifetimeAdvance;
use crate::control::tests::support::ManualClock;

#[tokio::test(start_paused = true)]
async fn idle_active_owner_emits_a_fresh_semantic_heartbeat() {
    let clock = ManualClock::new(1_000);
    let (lifetime, control, _gate, _drops) = active([], clock, None).await;
    let (_handle, mut cancellation) = endpoint_cancellation();
    let resources = wire::ResourceSample {
        resident_memory_bytes: 101,
        peak_resident_memory_bytes: 202,
        cpu_time_ms: 303,
        process_count: 1,
        open_file_count: 404,
        spool_bytes: 0,
    };

    let ActiveRunnerLifetimeAdvance::Continue(lifetime) = lifetime
        .advance_with_resource_sample(&mut cancellation, || Ok(resources))
        .await
    else {
        panic!("heartbeat must keep the active owner alive");
    };

    let frames = decode_frames(&control.written());
    let heartbeat_frame = frames.last().expect("heartbeat frame");
    let header = heartbeat_frame.header.as_ref().expect("heartbeat header");
    assert_eq!(header.stream_seq, 4);
    assert!(header.reply_to_message_id.is_none());
    let payload = wire::FramePayload::decode(heartbeat_frame.encoded_payload.as_slice())
        .expect("heartbeat payload");
    let Some(wire::frame_payload::Body::Heartbeat(heartbeat)) = payload.body else {
        panic!("last outbound payload must be Heartbeat");
    };
    assert_eq!(heartbeat.last_alive_at_unix_ms, 1_200);
    assert_eq!(heartbeat.last_progress_at_unix_ms, 1_200);
    assert_eq!(heartbeat.last_event_seq, 0);
    assert_eq!(heartbeat.phase, wire::PhysicalAttemptPhase::Active as i32);
    assert_eq!(heartbeat.resources, Some(resources));
    assert!(heartbeat.active_provider_operation_ids.is_empty());
    assert!(heartbeat.active_capability_operation_ids.is_empty());
    assert!(heartbeat.active_child_attempt_ids.is_empty());

    lifetime.revoke().close_local();
}

fn decode_frames(bytes: &[u8]) -> Vec<wire::Frame> {
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("control cap");
    let codec = DelimitedFrameCodec::new(maximum).expect("control codec");
    let mut cursor = Cursor::new(bytes);
    let mut frames = Vec::new();
    while let Some(encoded) = codec
        .read_raw(&mut cursor)
        .expect("delimited outbound frame")
    {
        frames.push(wire::Frame::decode(encoded.as_slice()).expect("outbound frame"));
    }
    frames
}
