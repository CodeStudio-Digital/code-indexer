use agent_protocol::generated::v1 as wire;
use sha2::{Digest, Sha256};
use tokio::time::Instant;

use super::{HydrationPumpState, PumpTransition};
use crate::bootstrap::control_service::hydration::RunnerHydrationRequest;
use crate::bootstrap::control_service::hydration::transport::pump::{
    HydrationDataPumpError, RunnerHydrationPumpContext,
};

const TRANSFER: &str = "pump-state-transfer";
const MANIFEST_DIGEST: [u8; 32] = [0x41; 32];

#[test]
fn manifest_chunks_and_complete_emit_the_exact_response_sequence() {
    let body = b"snapshot";
    let mut state = HydrationPumpState::new(request(body));
    let context = context();
    let progress = state
        .accept(&manifest(body), MANIFEST_DIGEST, 4, &context)
        .expect("manifest");
    assert_progress(progress, 0, 0, 4);

    let progress = state
        .accept(&chunk(0, b"snap", false), [0x51; 32], 4, &context)
        .expect("first chunk");
    assert_progress(progress, 0, 4, 4);
    let progress = state
        .accept(&chunk(4, b"shot", true), [0x52; 32], 4, &context)
        .expect("final chunk");
    assert_progress(progress, 1, 0, 0);

    let committed = state
        .accept(&complete(), [0x53; 32], 4, &context)
        .expect("complete");
    let PumpTransition::Committed {
        response,
        hydration,
    } = committed
    else {
        panic!("expected committed transition")
    };
    assert!(matches!(
        response.body,
        Some(wire::frame_payload::Body::HydrationCommitted(_))
    ));
    assert!(format!("{hydration:?}").contains("hydrated_bytes: 8"));
}

#[test]
fn a_chunk_before_manifest_is_rejected_without_creating_transfer_state() {
    let mut state = HydrationPumpState::new(request(b"snapshot"));
    assert!(matches!(
        state.accept(&chunk(0, b"snap", false), [0x51; 32], 4, &context()),
        Err(HydrationDataPumpError::UnexpectedPayload)
    ));
}

fn assert_progress(transition: PumpTransition, item: u32, offset: u64, credit: u64) {
    let PumpTransition::Progress(response) = transition else {
        panic!("expected progress transition")
    };
    let Some(wire::frame_payload::Body::HydrationProgress(progress)) = response.body else {
        panic!("expected HydrationProgress")
    };
    assert_eq!(progress.next_item_ordinal, item);
    assert_eq!(progress.next_offset, offset);
    assert_eq!(progress.max_next_chunk_bytes, credit);
}

fn request(body: &[u8]) -> RunnerHydrationRequest {
    RunnerHydrationRequest::new(
        vec![snapshot(body)],
        Vec::new(),
        wire::ResourceBudget {
            max_ipc_frames: 32,
            max_ipc_bytes: 64,
            max_spool_bytes: 64,
            max_artifact_bytes: 64,
            ..wire::ResourceBudget::default()
        },
    )
}

fn manifest(body: &[u8]) -> wire::frame_payload::Body {
    wire::frame_payload::Body::HydrationManifest(wire::HydrationManifest {
        transfer_id: TRANSFER.into(),
        items: vec![wire::HydrationItem {
            ordinal: 0,
            reference: Some(wire::hydration_item::Reference::Snapshot(snapshot(body))),
            byte_length: 8,
        }],
        total_payload_bytes: 8,
        max_chunk_bytes: 4,
        ..wire::HydrationManifest::default()
    })
}

fn chunk(offset: u64, bytes: &[u8], end_of_item: bool) -> wire::frame_payload::Body {
    wire::frame_payload::Body::HydrationChunk(wire::HydrationChunk {
        transfer_id: TRANSFER.into(),
        manifest_payload_sha256: MANIFEST_DIGEST.to_vec(),
        item_ordinal: 0,
        offset,
        encoded_chunk: bytes.to_vec(),
        chunk_sha256: Sha256::digest(bytes).to_vec(),
        end_of_item,
        ..wire::HydrationChunk::default()
    })
}

fn complete() -> wire::frame_payload::Body {
    wire::frame_payload::Body::HydrationComplete(wire::HydrationComplete {
        transfer_id: TRANSFER.into(),
        manifest_payload_sha256: MANIFEST_DIGEST.to_vec(),
        item_count: 1,
        total_payload_bytes: 8,
        ..wire::HydrationComplete::default()
    })
}

fn snapshot(body: &[u8]) -> wire::SnapshotRef {
    wire::SnapshotRef {
        r#ref: "snapshot:pump".into(),
        version: 1,
        content_sha256: Sha256::digest(body).to_vec(),
        origin: "host:test".into(),
        schema_id: "test.snapshot".into(),
        schema_version: 1,
    }
}

fn context() -> RunnerHydrationPumpContext {
    RunnerHydrationPumpContext {
        wire_identity: wire::AttemptIdentity::default(),
        runtime_instance_id: "runtime:test".into(),
        hard_deadline: Instant::now() + std::time::Duration::from_secs(1),
        semantic_deadline_at_unix_ms: 10_000,
    }
}
