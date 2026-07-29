use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use agent_protocol::generated::v1 as wire;
use agent_session_bridge::{
    BridgeInstanceId, FilesystemSessionStoreExtensionPort, SessionRootId,
    SessionStoreBridgeBootstrap, SessionStoreBridgeError, SessionStoreExtensionError,
    SessionStoreExtensionPort,
};
use agent_session_store::{
    LegacyTransferLimits, SessionId, SessionStoreLimits, verify_typescript_bundle_manifest,
};
use prost::Message;
use sha2::{Digest, Sha256};

const INSTANCE_ID: &str = "host:session-store:test";
const ROOT_ID: &str = "global";
const SESSION_ID: &str = "10000000-0000-0000-0000-000000000001";
const WRITER_ID: &str = "20000000-0000-0000-0000-000000000001";
const COMMIT_OPERATION_ID: &str = "30000000-0000-0000-0000-000000000001";
const ARCHIVE_OPERATION_ID: &str = "30000000-0000-0000-0000-000000000002";
const REQUEST_HASH_DOMAIN: &[u8] = b"codestudio.agent.session-store-request.v1\0";
const RESPONSE_HASH_DOMAIN: &[u8] = b"codestudio.agent.session-store-response.v1\0";
static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

struct TestRoot(PathBuf);

impl TestRoot {
    fn new(label: &str) -> Self {
        let nonce = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "codestudio-agent-session-bridge-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create test root");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove test root");
    }
}

#[test]
fn open_commit_query_archive_and_replay_stay_fenced() {
    let root = TestRoot::new("lifecycle");
    let mut bridge = bridge(&root);
    let opened = send(
        &mut bridge,
        1,
        wire::session_store_request::Body::OpenSessionWriter(open("open:1")),
    );
    let wire::session_store_response::Body::SessionWriterOpened(opened) =
        opened.body.expect("open response")
    else {
        panic!("expected opened response");
    };
    assert!(!opened.replay);
    let handle = opened.writer_handle;

    let replayed = send(
        &mut bridge,
        2,
        wire::session_store_request::Body::OpenSessionWriter(open("open:1")),
    );
    let wire::session_store_response::Body::SessionWriterOpened(replayed) =
        replayed.body.expect("open replay response")
    else {
        panic!("expected opened replay");
    };
    assert!(replayed.replay);
    assert_eq!(replayed.writer_handle, handle);
    assert_eq!(bridge.active_writer_count(), 1);

    let payload = br#"{"message":"hello"}"#;
    let committed = send(
        &mut bridge,
        3,
        wire::session_store_request::Body::CommitSessionRecord(commit(&handle, payload)),
    );
    let wire::session_store_response::Body::CommitSessionRecordReceipt(receipt) =
        committed.body.expect("commit response")
    else {
        panic!("expected commit receipt");
    };
    assert_eq!(receipt.global_sequence, 1);
    assert!(!receipt.replay);

    let replay = send(
        &mut bridge,
        4,
        wire::session_store_request::Body::CommitSessionRecord(commit(&handle, payload)),
    );
    let wire::session_store_response::Body::CommitSessionRecordReceipt(replay) =
        replay.body.expect("commit replay response")
    else {
        panic!("expected replay receipt");
    };
    assert!(replay.replay);
    assert_eq!(replay.commit_sha256, receipt.commit_sha256);

    let queried = send(
        &mut bridge,
        5,
        wire::session_store_request::Body::QuerySessionState(wire::QuerySessionState {
            writer_handle: handle.clone(),
            authority: Some(authority()),
        }),
    );
    let wire::session_store_response::Body::SessionState(state) =
        queried.body.expect("query response")
    else {
        panic!("expected session state");
    };
    assert_eq!(state.committed_records, 1);
    assert!(!state.archived);
    assert_eq!(state.last_commit_sha256, receipt.commit_sha256);

    let archived = send(
        &mut bridge,
        6,
        wire::session_store_request::Body::ArchiveSession(wire::ArchiveSession {
            writer_handle: handle,
            authority: Some(authority()),
            operation_id: ARCHIVE_OPERATION_ID.to_owned(),
            expected_previous_commit_sha256: receipt.commit_sha256,
        }),
    );
    let wire::session_store_response::Body::SessionArchived(archived) =
        archived.body.expect("archive response")
    else {
        panic!("expected archive receipt");
    };
    assert_eq!(
        archived
            .archive_receipt
            .expect("archive commit receipt")
            .global_sequence,
        2
    );
    assert_eq!(bridge.active_writer_count(), 0);
}

#[test]
fn committed_payload_read_is_path_free_fenced_and_byte_verified() {
    let root = TestRoot::new("committed-read");
    let mut bridge = bridge(&root);
    let opened = send(
        &mut bridge,
        1,
        wire::session_store_request::Body::OpenSessionWriter(open("open:read")),
    );
    let wire::session_store_response::Body::SessionWriterOpened(opened) =
        opened.body.expect("open response")
    else {
        panic!("expected opened response");
    };
    let payload = b"hydrated-snapshot";
    let committed = send(
        &mut bridge,
        2,
        wire::session_store_request::Body::CommitSessionRecord(commit(
            &opened.writer_handle,
            payload,
        )),
    );
    let wire::session_store_response::Body::CommitSessionRecordReceipt(receipt) =
        committed.body.expect("commit response")
    else {
        panic!("expected commit receipt");
    };
    let read = wire::ReadCommittedSessionPayload {
        writer_handle: opened.writer_handle,
        authority: Some(authority()),
        operation_id: COMMIT_OPERATION_ID.to_owned(),
        kind: wire::SessionRecordKind::Conversation.into(),
        expected_payload_sha256: receipt.payload_sha256.clone(),
        expected_payload_bytes: u64::try_from(payload.len()).expect("payload length"),
    };
    let loaded = send(
        &mut bridge,
        3,
        wire::session_store_request::Body::ReadCommittedSessionPayload(read.clone()),
    );
    let wire::session_store_response::Body::CommittedSessionPayload(loaded) =
        loaded.body.expect("read response")
    else {
        panic!("expected committed payload");
    };
    assert_eq!(loaded.encoded_payload, payload);
    assert_eq!(
        loaded
            .commit_receipt
            .expect("read commit receipt")
            .commit_sha256,
        receipt.commit_sha256
    );

    let mismatched = send(
        &mut bridge,
        4,
        wire::session_store_request::Body::ReadCommittedSessionPayload(
            wire::ReadCommittedSessionPayload {
                expected_payload_sha256: vec![9; 32],
                ..read.clone()
            },
        ),
    );
    let wire::session_store_response::Body::Failure(failure) =
        mismatched.body.expect("mismatch response")
    else {
        panic!("expected typed failure");
    };
    assert_eq!(
        failure.code,
        wire::SessionStoreFailureCode::DivergentReplay as i32
    );

    let payload_path = root
        .path()
        .join(SESSION_ID)
        .join("events")
        .join(format!("{}.blob", hex(&receipt.payload_sha256)));
    fs::write(payload_path, b"corrupted-snapshot").expect("tamper payload");
    let tampered = send(
        &mut bridge,
        5,
        wire::session_store_request::Body::ReadCommittedSessionPayload(read),
    );
    let wire::session_store_response::Body::Failure(failure) =
        tampered.body.expect("tamper response")
    else {
        panic!("expected corrupt bundle failure");
    };
    assert_eq!(
        failure.code,
        wire::SessionStoreFailureCode::CorruptBundle as i32
    );
    assert_eq!(bridge.active_writer_count(), 1);
}

#[test]
fn invalid_frame_poisons_the_opaque_owner() {
    let root = TestRoot::new("poison");
    let mut bridge = bridge(&root);
    let mut encoded = request_frame(
        1,
        wire::session_store_request::Body::OpenSessionWriter(open("open:1")),
    );
    let last = encoded.last_mut().expect("encoded frame");
    *last ^= 0xff;
    assert!(matches!(
        bridge.handle(&encoded, 100),
        Err(SessionStoreBridgeError::Decode | SessionStoreBridgeError::PayloadHashMismatch)
    ));
    assert_eq!(
        bridge.handle(
            &request_frame(
                1,
                wire::session_store_request::Body::OpenSessionWriter(open("open:1"))
            ),
            100
        ),
        Err(SessionStoreBridgeError::Poisoned)
    );
}

#[test]
fn unimplemented_transfer_is_typed_and_does_not_expose_a_path() {
    let root = TestRoot::new("transfer");
    let mut bridge = bridge(&root);
    let response = send(
        &mut bridge,
        1,
        wire::session_store_request::Body::TransferSessionStorageGeneration(
            wire::TransferSessionStorageGeneration {
                root_id: ROOT_ID.to_owned(),
                session_id: SESSION_ID.to_owned(),
                source_generation: wire::StorageGeneration::TypescriptFsV1.into(),
                target_generation: wire::StorageGeneration::RustFsV1.into(),
                expected_source_lease_epoch: 1,
                next_authority: Some(authority()),
                verified_manifest_sha256: vec![7; 32],
                idempotency_key: "transfer:1".to_owned(),
            },
        ),
    );
    let wire::session_store_response::Body::Failure(failure) =
        response.body.expect("failure response")
    else {
        panic!("expected typed failure");
    };
    assert_eq!(
        failure.code,
        wire::SessionStoreFailureCode::UnsupportedOperation as i32
    );
    assert_eq!(failure.reason_code, "native_extension_unavailable");
}

#[test]
fn transfer_routes_only_to_the_compiled_rust_extension() {
    let root = TestRoot::new("transfer-extension");
    let mut bridge = bridge_with_extensions(&root, Box::new(TransferExtension));
    let manifest_hash = vec![7; 32];
    let response = send(
        &mut bridge,
        1,
        wire::session_store_request::Body::TransferSessionStorageGeneration(
            wire::TransferSessionStorageGeneration {
                root_id: ROOT_ID.to_owned(),
                session_id: SESSION_ID.to_owned(),
                source_generation: wire::StorageGeneration::TypescriptFsV1.into(),
                target_generation: wire::StorageGeneration::RustFsV1.into(),
                expected_source_lease_epoch: 1,
                next_authority: Some(authority()),
                verified_manifest_sha256: manifest_hash.clone(),
                idempotency_key: "transfer:1".to_owned(),
            },
        ),
    );
    let wire::session_store_response::Body::SessionStorageTransferred(receipt) =
        response.body.expect("transfer response")
    else {
        panic!("expected transfer receipt");
    };
    assert_eq!(receipt.session_id, SESSION_ID);
    assert_eq!(receipt.verified_manifest_sha256, manifest_hash);
    assert_eq!(
        receipt.source_generation,
        wire::StorageGeneration::TypescriptFsV1 as i32
    );
}

#[test]
fn filesystem_extension_transfers_a_real_bundle_through_the_path_free_wire() {
    let root = TestRoot::new("real-transfer-extension");
    write_legacy_bundle(root.path(), 1);
    let transfer_limits = LegacyTransferLimits::new(
        64,
        64 * 1024,
        512 * 1024,
        SessionStoreLimits::new(16, 4096, 16).expect("journal limits"),
    )
    .expect("transfer limits");
    let manifest = verify_typescript_bundle_manifest(
        root.path(),
        &SessionId::parse(SESSION_ID).expect("session ID"),
        1,
        transfer_limits,
    )
    .expect("verified manifest");
    let mut bridge = bridge_with_extensions(
        &root,
        Box::new(FilesystemSessionStoreExtensionPort::new(transfer_limits)),
    );
    let transfer = wire::TransferSessionStorageGeneration {
        root_id: ROOT_ID.to_owned(),
        session_id: SESSION_ID.to_owned(),
        source_generation: wire::StorageGeneration::TypescriptFsV1.into(),
        target_generation: wire::StorageGeneration::RustFsV1.into(),
        expected_source_lease_epoch: 1,
        next_authority: Some(authority_epoch(2)),
        verified_manifest_sha256: manifest.to_vec(),
        idempotency_key: "transfer:wire".to_owned(),
    };
    let response = send(
        &mut bridge,
        1,
        wire::session_store_request::Body::TransferSessionStorageGeneration(transfer.clone()),
    );
    let wire::session_store_response::Body::SessionStorageTransferred(receipt) =
        response.body.expect("transfer response")
    else {
        panic!("expected physical transfer receipt");
    };
    assert!(!receipt.replay);
    assert_eq!(receipt.verified_manifest_sha256, manifest);
    assert!(
        root.path()
            .join(SESSION_ID)
            .join("legacy/typescript_fs_v1/state.json")
            .is_file()
    );

    let replay = send(
        &mut bridge,
        2,
        wire::session_store_request::Body::TransferSessionStorageGeneration(transfer),
    );
    let wire::session_store_response::Body::SessionStorageTransferred(replay) =
        replay.body.expect("transfer replay")
    else {
        panic!("expected transfer replay receipt");
    };
    assert!(replay.replay);
    assert_eq!(
        replay.activation_receipt_sha256,
        receipt.activation_receipt_sha256
    );
}

fn bridge(root: &TestRoot) -> agent_session_bridge::AuthenticatedSessionStoreBridge {
    bridge_with_extensions(
        root,
        Box::<agent_session_bridge::RejectingSessionStoreExtensionPort>::default(),
    )
}

fn bridge_with_extensions(
    root: &TestRoot,
    extensions: Box<dyn SessionStoreExtensionPort>,
) -> agent_session_bridge::AuthenticatedSessionStoreBridge {
    let mut bootstrap = SessionStoreBridgeBootstrap::new(
        BridgeInstanceId::parse(INSTANCE_ID).expect("instance ID"),
        64 * 1024,
    )
    .expect("bootstrap");
    bootstrap
        .register_root(SessionRootId::parse(ROOT_ID).expect("root ID"), root.path())
        .expect("register root");
    bootstrap.with_extensions(extensions).bind()
}

fn authority() -> wire::SessionStoreAuthority {
    authority_epoch(1)
}

fn authority_epoch(epoch: u64) -> wire::SessionStoreAuthority {
    wire::SessionStoreAuthority {
        storage_generation: wire::StorageGeneration::RustFsV1.into(),
        lease_epoch: epoch,
        writer_id: WRITER_ID.to_owned(),
    }
}

fn write_legacy_bundle(root: &Path, fence: u64) {
    let bundle = root.join(SESSION_ID);
    for directory in ["metrics", "events", "attachments"] {
        fs::create_dir_all(bundle.join(directory)).expect("create legacy directory");
    }
    fs::write(
        bundle.join("session.json"),
        format!("{{\"schema_version\":1,\"id\":\"{SESSION_ID}\",\"kind\":\"global\"}}\n"),
    )
    .expect("session metadata");
    fs::write(
        bundle.join("state.json"),
        b"{\"schema_version\":1,\"status\":\"idle\"}\n",
    )
    .expect("state");
    fs::write(bundle.join("conversation.jsonl"), b"").expect("conversation");
    fs::write(
        bundle.join("migration.json"),
        b"{\"schema_version\":1,\"source\":\"native\"}\n",
    )
    .expect("migration");
    fs::write(
        bundle.join("metrics/summary.json"),
        b"{\"schema_version\":1,\"turns\":1}\n",
    )
    .expect("metrics");
    fs::write(
        bundle.join("events/writer.fence.json"),
        format!("{{\"schema_version\":1,\"fence\":{fence}}}\n"),
    )
    .expect("fence");
    fs::write(bundle.join("attachments/data.bin"), b"legacy").expect("attachment");
}

fn open(idempotency_key: &str) -> wire::OpenSessionWriter {
    wire::OpenSessionWriter {
        root_id: ROOT_ID.to_owned(),
        session_id: SESSION_ID.to_owned(),
        authority: Some(authority()),
        limits: Some(wire::SessionStoreLimits {
            max_records: 8,
            max_payload_bytes: 1024,
            max_authority_transitions: 8,
        }),
        idempotency_key: idempotency_key.to_owned(),
    }
}

fn commit(handle: &str, payload: &[u8]) -> wire::CommitSessionRecord {
    wire::CommitSessionRecord {
        writer_handle: handle.to_owned(),
        authority: Some(authority()),
        operation_id: COMMIT_OPERATION_ID.to_owned(),
        kind: wire::SessionRecordKind::Conversation.into(),
        durability: wire::SessionDurabilityClass::Durable.into(),
        encoded_payload: payload.to_vec(),
        expected_payload_sha256: Sha256::digest(payload).to_vec(),
    }
}

fn send(
    bridge: &mut agent_session_bridge::AuthenticatedSessionStoreBridge,
    sequence: u64,
    body: wire::session_store_request::Body,
) -> wire::SessionStoreResponse {
    let encoded = bridge
        .handle(&request_frame(sequence, body), 100)
        .expect("bridge response");
    let frame =
        wire::SessionStoreResponseFrame::decode(encoded.as_slice()).expect("decode response frame");
    let header = frame.header.expect("response header");
    assert_eq!(header.stream_seq, sequence);
    assert_eq!(
        header.response_payload_sha256,
        hash(RESPONSE_HASH_DOMAIN, &frame.encoded_response)
    );
    wire::SessionStoreResponse::decode(frame.encoded_response.as_slice()).expect("decode response")
}

fn request_frame(sequence: u64, body: wire::session_store_request::Body) -> Vec<u8> {
    let encoded_request = wire::SessionStoreRequest { body: Some(body) }.encode_to_vec();
    wire::SessionStoreRequestFrame {
        header: Some(wire::SessionStoreRequestHeader {
            protocol_version: 1,
            bridge_instance_id: INSTANCE_ID.to_owned(),
            request_id: format!("request:{sequence}"),
            stream_seq: sequence,
            sent_at_unix_ms: 90,
            deadline_at_unix_ms: 110,
            request_payload_sha256: hash(REQUEST_HASH_DOMAIN, &encoded_request),
        }),
        encoded_request,
    }
    .encode_to_vec()
}

fn hash(domain: &[u8], payload: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(payload);
    hasher.finalize().to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(
        String::with_capacity(bytes.len() * 2),
        |mut output, byte| {
            write!(&mut output, "{byte:02x}").expect("write hex");
            output
        },
    )
}

#[derive(Debug)]
struct TransferExtension;

impl SessionStoreExtensionPort for TransferExtension {
    fn publish_projection(
        &mut self,
        _request: wire::PublishSessionProjection,
    ) -> Result<wire::SessionProjectionPublished, SessionStoreExtensionError> {
        Err(SessionStoreExtensionError::Unsupported)
    }

    fn transfer_storage(
        &mut self,
        _root: &Path,
        request: wire::TransferSessionStorageGeneration,
    ) -> Result<wire::SessionStorageTransferred, SessionStoreExtensionError> {
        Ok(wire::SessionStorageTransferred {
            session_id: request.session_id,
            source_generation: request.source_generation,
            activated_authority: request.next_authority,
            verified_manifest_sha256: request.verified_manifest_sha256,
            activation_receipt_sha256: vec![9; 32],
            replay: false,
        })
    }
}
