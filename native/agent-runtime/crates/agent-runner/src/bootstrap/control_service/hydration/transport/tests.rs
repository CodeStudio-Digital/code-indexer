use agent_protocol::generated::v1 as wire;
use sha2::{Digest, Sha256};

use super::{HydrationTransportError, RunnerHydrationRequest};

const TRANSFER_ID: &str = "hydration:test:1";
const MANIFEST_DIGEST: [u8; 32] = [7; 32];

#[test]
fn exact_stop_and_wait_transfer_verifies_and_owns_every_item() {
    let snapshot_body = b"secret-a";
    let artifact_body = b"secret-b";
    let snapshot = snapshot("snapshot:policy", snapshot_body);
    let artifact = artifact("artifact:task", artifact_body);
    let request = request(snapshot.clone(), artifact.clone(), 32);
    let (mut transfer, initial) = request
        .begin_transfer(manifest(&snapshot, &artifact, 4), MANIFEST_DIGEST, 8)
        .expect("valid manifest");
    assert_eq!(initial.max_next_chunk_bytes, 4);
    assert!(format!("{transfer:?}").contains("[REDACTED]"));

    let first = transfer
        .accept_chunk(&chunk(0, 0, b"secr", false))
        .expect("first snapshot chunk");
    assert_eq!(first.next_item_ordinal, 0);
    assert_eq!(first.next_offset, 4);
    assert_eq!(first.accepted_payload_bytes, 4);
    let second = transfer
        .accept_chunk(&chunk(0, 4, b"et-a", true))
        .expect("finish snapshot");
    assert_eq!(second.next_item_ordinal, 1);
    assert_eq!(second.next_offset, 0);
    transfer
        .accept_chunk(&chunk(1, 0, b"secr", false))
        .expect("first artifact chunk");
    let final_cursor = transfer
        .accept_chunk(&chunk(1, 4, b"et-b", true))
        .expect("finish artifact");
    assert_eq!(final_cursor.next_item_ordinal, 2);
    assert_eq!(final_cursor.max_next_chunk_bytes, 0);

    let verified = transfer.finish(&complete(2, 16)).expect("commit transfer");
    let rendered = format!("{verified:?}");
    assert!(rendered.contains("hydrated_bytes: 16"));
    assert!(!rendered.contains("secret-a"));
    assert!(!rendered.contains("secret-b"));
}

#[test]
fn manifest_must_match_order_metadata_totals_and_budgets() {
    let snapshot = snapshot("snapshot:policy", b"snapshot");
    let artifact = artifact("artifact:task", b"artifact");
    let mut swapped = manifest(&snapshot, &artifact, 4);
    swapped.items.swap(0, 1);
    assert!(matches!(
        request(snapshot.clone(), artifact.clone(), 32).begin_transfer(swapped, MANIFEST_DIGEST, 8),
        Err(HydrationTransportError::ManifestCoverage)
    ));

    let mut wrong_total = manifest(&snapshot, &artifact, 4);
    wrong_total.total_payload_bytes = 15;
    assert!(matches!(
        request(snapshot.clone(), artifact.clone(), 32).begin_transfer(
            wrong_total,
            MANIFEST_DIGEST,
            8
        ),
        Err(HydrationTransportError::ManifestByteBudget)
    ));

    let over_budget = manifest(&snapshot, &artifact, 4);
    assert!(matches!(
        request(snapshot, artifact, 8).begin_transfer(over_budget, MANIFEST_DIGEST, 8),
        Err(HydrationTransportError::ManifestByteBudget)
    ));
}

#[test]
fn a_bad_chunk_poisons_the_transfer_before_payload_ownership() {
    let snapshot = snapshot("snapshot:policy", b"snapshot");
    let artifact = artifact("artifact:task", b"artifact");
    let (mut transfer, _) = request(snapshot.clone(), artifact.clone(), 32)
        .begin_transfer(manifest(&snapshot, &artifact, 4), MANIFEST_DIGEST, 8)
        .expect("valid manifest");
    let mut corrupt = chunk(0, 0, b"snap", false);
    corrupt.chunk_sha256 = vec![9; 32];
    assert_eq!(
        transfer.accept_chunk(&corrupt),
        Err(HydrationTransportError::ChunkHash)
    );
    assert_eq!(
        transfer.accept_chunk(&chunk(0, 0, b"snap", false)),
        Err(HydrationTransportError::Poisoned)
    );
}

#[test]
fn chunk_geometry_and_total_frame_budget_are_sealed_by_the_manifest() {
    let snapshot = snapshot("snapshot:policy", b"snapshot");
    let artifact = artifact("artifact:task", b"artifact");
    let mut too_many_frames = request(snapshot.clone(), artifact.clone(), 32);
    too_many_frames.resource_budget.max_ipc_frames = 13;
    assert!(matches!(
        too_many_frames.begin_transfer(manifest(&snapshot, &artifact, 4), MANIFEST_DIGEST, 8),
        Err(HydrationTransportError::ManifestFrameBudget)
    ));

    let (mut transfer, _) = request(snapshot.clone(), artifact.clone(), 32)
        .begin_transfer(manifest(&snapshot, &artifact, 4), MANIFEST_DIGEST, 8)
        .expect("valid manifest");
    assert_eq!(
        transfer.accept_chunk(&chunk(0, 0, b"sn", false)),
        Err(HydrationTransportError::ChunkLimit)
    );
    assert_eq!(
        transfer.accept_chunk(&chunk(0, 0, b"snap", false)),
        Err(HydrationTransportError::Poisoned)
    );
}

#[test]
fn completion_requires_every_exact_byte_and_manifest_binding() {
    let snapshot = snapshot("snapshot:policy", b"snapshot");
    let artifact = artifact("artifact:task", b"artifact");
    let (mut transfer, _) = request(snapshot.clone(), artifact.clone(), 32)
        .begin_transfer(manifest(&snapshot, &artifact, 8), MANIFEST_DIGEST, 8)
        .expect("valid manifest");
    transfer
        .accept_chunk(&chunk(0, 0, b"snapshot", true))
        .expect("snapshot");
    assert!(matches!(
        transfer.finish(&complete(2, 16)),
        Err(HydrationTransportError::IncompleteTransfer)
    ));

    let (mut transfer, _) = request(snapshot.clone(), artifact.clone(), 32)
        .begin_transfer(manifest(&snapshot, &artifact, 8), MANIFEST_DIGEST, 8)
        .expect("valid manifest");
    let mut wrong_binding = chunk(0, 0, b"snapshot", true);
    wrong_binding.manifest_payload_sha256 = vec![8; 32];
    assert_eq!(
        transfer.accept_chunk(&wrong_binding),
        Err(HydrationTransportError::ManifestDigestMismatch)
    );
}

fn request(
    snapshot: wire::SnapshotRef,
    artifact: wire::ArtifactRef,
    max_ipc_bytes: u64,
) -> RunnerHydrationRequest {
    RunnerHydrationRequest::new(
        vec![snapshot],
        vec![artifact],
        wire::ResourceBudget {
            max_ipc_bytes,
            max_ipc_frames: 128,
            max_spool_bytes: max_ipc_bytes,
            max_artifact_bytes: max_ipc_bytes,
            ..wire::ResourceBudget::default()
        },
    )
}

fn manifest(
    snapshot: &wire::SnapshotRef,
    artifact: &wire::ArtifactRef,
    max_chunk_bytes: u64,
) -> wire::HydrationManifest {
    wire::HydrationManifest {
        transfer_id: TRANSFER_ID.to_owned(),
        items: vec![
            wire::HydrationItem {
                ordinal: 0,
                reference: Some(wire::hydration_item::Reference::Snapshot(snapshot.clone())),
                byte_length: 8,
            },
            wire::HydrationItem {
                ordinal: 1,
                reference: Some(wire::hydration_item::Reference::Artifact(artifact.clone())),
                byte_length: 8,
            },
        ],
        total_payload_bytes: 16,
        max_chunk_bytes,
        ..wire::HydrationManifest::default()
    }
}

fn chunk(item_ordinal: u32, offset: u64, body: &[u8], end_of_item: bool) -> wire::HydrationChunk {
    wire::HydrationChunk {
        transfer_id: TRANSFER_ID.to_owned(),
        manifest_payload_sha256: MANIFEST_DIGEST.to_vec(),
        item_ordinal,
        offset,
        encoded_chunk: body.to_vec(),
        chunk_sha256: sha256(body).to_vec(),
        end_of_item,
        ..wire::HydrationChunk::default()
    }
}

fn complete(item_count: u32, total_payload_bytes: u64) -> wire::HydrationComplete {
    wire::HydrationComplete {
        transfer_id: TRANSFER_ID.to_owned(),
        manifest_payload_sha256: MANIFEST_DIGEST.to_vec(),
        item_count,
        total_payload_bytes,
        ..wire::HydrationComplete::default()
    }
}

fn snapshot(reference: &str, body: &[u8]) -> wire::SnapshotRef {
    wire::SnapshotRef {
        r#ref: reference.to_owned(),
        version: 1,
        content_sha256: sha256(body).to_vec(),
        origin: "host:test".to_owned(),
        schema_id: "test.snapshot".to_owned(),
        schema_version: 1,
    }
}

fn artifact(artifact_id: &str, body: &[u8]) -> wire::ArtifactRef {
    wire::ArtifactRef {
        artifact_id: artifact_id.to_owned(),
        kind: "test".to_owned(),
        content_sha256: sha256(body).to_vec(),
        media_type: "application/octet-stream".to_owned(),
        byte_length: u64::try_from(body.len()).expect("artifact length"),
        compression: wire::ArtifactCompression::None.into(),
        privacy_class: wire::ArtifactPrivacyClass::Internal.into(),
        redaction_policy_version: "1".to_owned(),
        owner_session_id: "11111111-1111-4111-8111-111111111111".to_owned(),
    }
}

fn sha256(body: &[u8]) -> [u8; 32] {
    Sha256::digest(body).into()
}
