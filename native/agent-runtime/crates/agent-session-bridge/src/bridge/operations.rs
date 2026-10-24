use agent_protocol::generated::v1 as wire;
use agent_session_store::{
    AppendRequest, DurabilityClass, OperationId, SessionId, SessionJournal, SessionRecordKind,
};
use sha2::{Digest, Sha256};

use super::failure::{from_store, invalid};
use super::{AuthenticatedSessionStoreBridge, WriterEntry};
use crate::SessionRootId;
use crate::convert::{
    authority_from_wire, authority_to_wire, durability_from_wire, kind_from_wire, limits_from_wire,
    receipt_to_wire, state_to_wire,
};

mod lifecycle;
mod list;
mod read;
mod reader;
mod root_lock;

impl AuthenticatedSessionStoreBridge {
    pub(super) fn dispatch(
        &mut self,
        request: wire::SessionStoreRequest,
    ) -> wire::SessionStoreResponse {
        use wire::session_store_request::Body;
        match request
            .body
            .expect("frame validation requires a request body")
        {
            Body::OpenSessionWriter(request) => self.open(request),
            Body::CommitSessionRecord(request) => self.commit(request),
            Body::PublishSessionProjection(request) => self.publish_projection(request),
            Body::QuerySessionState(request) => self.query(request),
            Body::TransferSessionStorageGeneration(request) => self.transfer(request),
            Body::ArchiveSession(request) => self.archive(request),
            Body::CloseSessionWriter(request) => self.close(request),
            Body::ReadCommittedSessionPayload(request) => self.read_committed_payload(request),
            Body::ListCommittedSessionRecords(request) => self.list_committed_records(request),
            Body::OpenSessionReader(request) => self.open_reader(request),
            Body::CloseSessionReader(request) => self.close_reader(request),
            Body::AcquireStorageRootLock(request) => self.acquire_root_lock(&request),
            Body::ReleaseStorageRootLock(request) => self.release_root_lock(request),
            Body::InspectSupervisorLifecycleEvidence(request) => self.inspect_lifecycle(&request),
        }
    }

    fn open(&mut self, request: wire::OpenSessionWriter) -> wire::SessionStoreResponse {
        let parsed = (|| {
            let root_id = SessionRootId::parse(&request.root_id)
                .map_err(|_| agent_session_store::SessionStoreError::InvalidRoot)?;
            let root = self
                .roots
                .get(&root_id)
                .cloned()
                .ok_or(agent_session_store::SessionStoreError::InvalidRoot)?;
            let session_id = SessionId::parse(request.session_id)?;
            let authority = authority_from_wire(request.authority)?;
            let limits = limits_from_wire(request.limits)?;
            if request.idempotency_key.is_empty() {
                return Err(agent_session_store::SessionStoreError::DivergentReplay);
            }
            if let Some((handle, entry)) = self.writers.iter().find(|(_, entry)| {
                entry.root_id == root_id
                    && entry.session_id == session_id
                    && entry.authority == authority
                    && entry.open_idempotency_key == request.idempotency_key
            }) {
                return Ok(opened(handle.clone(), entry, true));
            }
            let journal =
                SessionJournal::open(&root, session_id.clone(), authority.clone(), limits)?;
            let handle = self.next_handle()?;
            let entry = WriterEntry {
                root_id,
                open_idempotency_key: request.idempotency_key,
                session_id,
                authority,
                journal,
            };
            let response = opened(handle.clone(), &entry, false);
            self.writers.insert(handle, entry);
            Ok(response)
        })();
        parsed.unwrap_or_else(|error| from_store(&error))
    }

    fn commit(&mut self, request: wire::CommitSessionRecord) -> wire::SessionStoreResponse {
        let parsed = (|| {
            let authority = authority_from_wire(request.authority)?;
            let entry = self
                .writers
                .get_mut(&request.writer_handle)
                .ok_or(agent_session_store::SessionStoreError::StaleAuthority)?;
            if entry.authority != authority {
                return Err(agent_session_store::SessionStoreError::StaleAuthority);
            }
            verify_expected_hash(&request.encoded_payload, &request.expected_payload_sha256)?;
            let operation_id = OperationId::parse(request.operation_id)?;
            let outcome = entry.journal.append(AppendRequest {
                operation_id: &operation_id,
                kind: kind_from_wire(request.kind)?,
                durability: durability_from_wire(request.durability)?,
                payload: &request.encoded_payload,
            })?;
            Ok(wire::SessionStoreResponse {
                body: Some(
                    wire::session_store_response::Body::CommitSessionRecordReceipt(
                        receipt_to_wire(&outcome),
                    ),
                ),
            })
        })();
        parsed.unwrap_or_else(|error| from_store(&error))
    }

    fn query(&self, request: wire::QuerySessionState) -> wire::SessionStoreResponse {
        if !request.reader_handle.is_empty() {
            return self.query_reader(request);
        }
        let Ok(authority) = authority_from_wire(request.authority) else {
            return invalid("invalid_storage_authority");
        };
        let Some(entry) = self.writers.get(&request.writer_handle) else {
            return writer_not_found();
        };
        if entry.authority != authority {
            return from_store(&agent_session_store::SessionStoreError::StaleAuthority);
        }
        wire::SessionStoreResponse {
            body: Some(wire::session_store_response::Body::SessionState(
                state_to_wire(&entry.journal.snapshot()),
            )),
        }
    }

    fn archive(&mut self, request: wire::ArchiveSession) -> wire::SessionStoreResponse {
        let parsed = (|| {
            let authority = authority_from_wire(request.authority)?;
            let entry = self
                .writers
                .get_mut(&request.writer_handle)
                .ok_or(agent_session_store::SessionStoreError::StaleAuthority)?;
            if entry.authority != authority
                || request.expected_previous_commit_sha256
                    != entry.journal.snapshot().last_commit_hash()
            {
                return Err(agent_session_store::SessionStoreError::StaleAuthority);
            }
            let operation_id = OperationId::parse(request.operation_id)?;
            let outcome = entry.journal.append(AppendRequest {
                operation_id: &operation_id,
                kind: SessionRecordKind::Archive,
                durability: DurabilityClass::Authoritative,
                payload: &[],
            })?;
            let receipt = receipt_to_wire(&outcome);
            self.writers.remove(&request.writer_handle);
            Ok(wire::SessionStoreResponse {
                body: Some(wire::session_store_response::Body::SessionArchived(
                    wire::SessionArchived {
                        archive_receipt: Some(receipt),
                    },
                )),
            })
        })();
        parsed.unwrap_or_else(|error| from_store(&error))
    }

    fn close(&mut self, request: wire::CloseSessionWriter) -> wire::SessionStoreResponse {
        let Ok(authority) = authority_from_wire(request.authority) else {
            return invalid("invalid_storage_authority");
        };
        let Some(entry) = self.writers.get(&request.writer_handle) else {
            return writer_not_found();
        };
        if entry.authority != authority {
            return from_store(&agent_session_store::SessionStoreError::StaleAuthority);
        }
        let entry = self
            .writers
            .remove(&request.writer_handle)
            .expect("writer existence checked above");
        wire::SessionStoreResponse {
            body: Some(wire::session_store_response::Body::SessionWriterClosed(
                wire::SessionWriterClosed {
                    session_id: entry.session_id.as_str().to_owned(),
                    authority: Some(authority_to_wire(&entry.authority)),
                },
            )),
        }
    }
}

fn opened(handle: String, entry: &WriterEntry, replay: bool) -> wire::SessionStoreResponse {
    let state = entry.journal.snapshot();
    wire::SessionStoreResponse {
        body: Some(wire::session_store_response::Body::SessionWriterOpened(
            wire::SessionWriterOpened {
                writer_handle: handle,
                session_id: entry.session_id.as_str().to_owned(),
                authority: Some(authority_to_wire(&entry.authority)),
                committed_records: state.committed_records(),
                last_commit_sha256: state.last_commit_hash().to_vec(),
                archived: state.archived(),
                replay,
            },
        )),
    }
}

fn verify_expected_hash(
    payload: &[u8],
    expected: &[u8],
) -> Result<(), agent_session_store::SessionStoreError> {
    if expected.len() != 32 || Sha256::digest(payload).as_slice() != expected {
        return Err(agent_session_store::SessionStoreError::DivergentReplay);
    }
    Ok(())
}

fn writer_not_found() -> wire::SessionStoreResponse {
    wire::SessionStoreResponse {
        body: Some(wire::session_store_response::Body::Failure(
            wire::SessionStoreFailure {
                code: wire::SessionStoreFailureCode::WriterNotFound.into(),
                reason_code: "session_writer_not_found".to_owned(),
                redacted_detail: None,
                retryable: false,
            },
        )),
    }
}
