use agent_protocol::generated::v1 as wire;
use sha2::{Digest, Sha256};

use super::{
    RunnerHydratedArtifact, RunnerHydratedSnapshot, RunnerHydrationError, RunnerHydrationRequest,
};

const SESSION_ID: &str = "11111111-1111-4111-8111-111111111111";

#[test]
fn exact_inputs_are_owned_normalized_and_redacted() {
    let snapshot_bytes = b"snapshot-body".to_vec();
    let artifact_bytes = b"artifact-body".to_vec();
    let expected_snapshot = snapshot("snapshot:policy", &snapshot_bytes);
    let expected_artifact = artifact("artifact:task", &artifact_bytes);
    let request = request(
        vec![expected_snapshot.clone()],
        vec![expected_artifact.clone()],
        1024,
    );
    let verified = request
        .verify(
            vec![RunnerHydratedSnapshot {
                reference: expected_snapshot,
                encoded_payload: snapshot_bytes,
            }],
            vec![RunnerHydratedArtifact {
                reference: expected_artifact,
                encoded_payload: artifact_bytes,
            }],
        )
        .expect("exact hydration");
    let rendered = format!("{verified:?}");
    assert!(rendered.contains("hydrated_bytes: 26"));
    assert!(!rendered.contains("snapshot-body"));
    assert!(!rendered.contains("artifact-body"));
}

#[test]
fn hash_metadata_and_coverage_mismatches_fail_closed() {
    let bytes = b"snapshot".to_vec();
    let expected = snapshot("snapshot:policy", &bytes);
    let hydration_request = request(vec![expected.clone()], Vec::new(), 1024);
    assert!(matches!(
        hydration_request.verify(
            vec![RunnerHydratedSnapshot {
                reference: expected,
                encoded_payload: b"tampered".to_vec(),
            }],
            Vec::new(),
        ),
        Err(RunnerHydrationError::ContentHash)
    ));

    let expected = snapshot("snapshot:policy", &bytes);
    let mut divergent = expected.clone();
    divergent.version = 2;
    assert!(matches!(
        request(vec![expected], Vec::new(), 1024).verify(
            vec![RunnerHydratedSnapshot {
                reference: divergent,
                encoded_payload: bytes,
            }],
            Vec::new(),
        ),
        Err(RunnerHydrationError::SnapshotMetadata)
    ));
}

#[test]
fn byte_and_artifact_budgets_are_enforced_before_prepared() {
    let snapshot_bytes = b"snapshot".to_vec();
    let snapshot = snapshot("snapshot:policy", &snapshot_bytes);
    assert!(matches!(
        request(vec![snapshot.clone()], Vec::new(), 4).verify(
            vec![RunnerHydratedSnapshot {
                reference: snapshot,
                encoded_payload: snapshot_bytes,
            }],
            Vec::new(),
        ),
        Err(RunnerHydrationError::ByteBudget)
    ));

    let artifact = artifact("artifact:large", b"artifact");
    let mut budget = resource_budget(1024);
    budget.max_artifact_bytes = 2;
    let request = RunnerHydrationRequest::new(Vec::new(), vec![artifact.clone()], budget);
    assert!(matches!(
        request.verify(
            Vec::new(),
            vec![RunnerHydratedArtifact {
                reference: artifact,
                encoded_payload: b"artifact".to_vec(),
            }],
        ),
        Err(RunnerHydrationError::ArtifactLength)
    ));
}

fn request(
    snapshots: Vec<wire::SnapshotRef>,
    artifacts: Vec<wire::ArtifactRef>,
    max_ipc_bytes: u64,
) -> RunnerHydrationRequest {
    RunnerHydrationRequest::new(snapshots, artifacts, resource_budget(max_ipc_bytes))
}

fn resource_budget(max_ipc_bytes: u64) -> wire::ResourceBudget {
    wire::ResourceBudget {
        soft_memory_bytes: 1024,
        hard_memory_bytes: 2048,
        cpu_time_ms: 100,
        max_wall_ms: 1_000,
        max_processes: 1,
        max_threads: 1,
        max_open_handles: 16,
        max_hot_transcript_bytes: 1024,
        max_ipc_frames: 64,
        max_ipc_bytes,
        max_spool_bytes: 1024,
        max_artifact_bytes: 1024,
        max_concurrent_tools: 1,
        max_blocking_tasks: 1,
        cancel_grace_ms: 10,
    }
}

fn snapshot(reference: &str, payload: &[u8]) -> wire::SnapshotRef {
    wire::SnapshotRef {
        r#ref: reference.to_owned(),
        version: 1,
        content_sha256: Sha256::digest(payload).to_vec(),
        origin: "test".to_owned(),
        schema_id: "codestudio.test.v1".to_owned(),
        schema_version: 1,
    }
}

fn artifact(artifact_id: &str, payload: &[u8]) -> wire::ArtifactRef {
    wire::ArtifactRef {
        artifact_id: artifact_id.to_owned(),
        kind: "input".to_owned(),
        content_sha256: Sha256::digest(payload).to_vec(),
        media_type: "application/octet-stream".to_owned(),
        byte_length: u64::try_from(payload.len()).expect("payload length"),
        compression: wire::ArtifactCompression::None as i32,
        privacy_class: wire::ArtifactPrivacyClass::Internal as i32,
        redaction_policy_version: "v1".to_owned(),
        owner_session_id: SESSION_ID.to_owned(),
        display_name: String::new(),
    }
}
