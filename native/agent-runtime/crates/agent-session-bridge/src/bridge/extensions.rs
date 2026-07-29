use agent_protocol::generated::v1 as wire;
use agent_session_store::{OperationId, SessionId};

use super::AuthenticatedSessionStoreBridge;
use super::failure::{from_store, invalid};
use crate::SessionRootId;
use crate::SessionStoreExtensionError;
use crate::convert::authority_from_wire;

impl AuthenticatedSessionStoreBridge {
    pub(super) fn publish_projection(
        &mut self,
        request: wire::PublishSessionProjection,
    ) -> wire::SessionStoreResponse {
        if !valid_projection(&request) {
            return invalid("invalid_projection_request");
        }
        let Ok(authority) = authority_from_wire(request.authority.clone()) else {
            return invalid("invalid_storage_authority");
        };
        let Some(entry) = self.writers.get(&request.writer_handle) else {
            return invalid("session_writer_not_found");
        };
        if entry.authority != authority {
            return from_store(&agent_session_store::SessionStoreError::StaleAuthority);
        }
        let expected = ProjectionExpectation {
            session_id: entry.session_id.as_str().to_owned(),
            operation_id: request.operation_id.clone(),
            authority: request.authority.clone(),
            projection_kind: request.projection_kind.clone(),
            projection_version: request.projection_version,
            commit_sha256: request.expected_commit_sha256.clone(),
        };
        match self.extensions.publish_projection(request) {
            Ok(receipt) if expected.matches(&receipt) => wire::SessionStoreResponse {
                body: Some(wire::session_store_response::Body::SessionProjectionPublished(receipt)),
            },
            Ok(_) => invalid("divergent_projection_receipt"),
            Err(error) => extension_failure(error),
        }
    }

    pub(super) fn transfer(
        &mut self,
        request: wire::TransferSessionStorageGeneration,
    ) -> wire::SessionStoreResponse {
        if !self.valid_transfer(&request) {
            return invalid("invalid_storage_transfer");
        }
        let expected = TransferExpectation {
            session_id: request.session_id.clone(),
            source_generation: request.source_generation,
            activated_authority: request.next_authority.clone(),
            verified_manifest_sha256: request.verified_manifest_sha256.clone(),
        };
        let root_id = SessionRootId::parse(&request.root_id)
            .expect("transfer root was validated before resolution");
        let root = self
            .roots
            .get(&root_id)
            .expect("validated transfer root remains registered")
            .clone();
        match self.extensions.transfer_storage(&root, request) {
            Ok(receipt) if expected.matches(&receipt) => wire::SessionStoreResponse {
                body: Some(wire::session_store_response::Body::SessionStorageTransferred(receipt)),
            },
            Ok(_) => invalid("divergent_transfer_receipt"),
            Err(error) => extension_failure(error),
        }
    }

    fn valid_transfer(&self, request: &wire::TransferSessionStorageGeneration) -> bool {
        let Ok(root_id) = SessionRootId::parse(&request.root_id) else {
            return false;
        };
        self.roots.contains_key(&root_id)
            && SessionId::parse(request.session_id.clone()).is_ok()
            && request.source_generation == wire::StorageGeneration::TypescriptFsV1 as i32
            && request.target_generation == wire::StorageGeneration::RustFsV1 as i32
            && request.expected_source_lease_epoch > 0
            && authority_from_wire(request.next_authority.clone()).is_ok()
            && request.verified_manifest_sha256.len() == 32
            && !request.idempotency_key.is_empty()
    }
}

fn valid_projection(request: &wire::PublishSessionProjection) -> bool {
    !request.writer_handle.is_empty()
        && OperationId::parse(request.operation_id.clone()).is_ok()
        && !request.projection_kind.is_empty()
        && request.projection_kind.len() <= 64
        && request
            .projection_kind
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && request.projection_version > 0
        && request.expected_commit_sha256.len() == 32
}

struct ProjectionExpectation {
    session_id: String,
    operation_id: String,
    authority: Option<wire::SessionStoreAuthority>,
    projection_kind: String,
    projection_version: u64,
    commit_sha256: Vec<u8>,
}

impl ProjectionExpectation {
    fn matches(&self, receipt: &wire::SessionProjectionPublished) -> bool {
        receipt.session_id == self.session_id
            && receipt.operation_id == self.operation_id
            && receipt.authority == self.authority
            && receipt.projection_kind == self.projection_kind
            && receipt.projection_version == self.projection_version
            && receipt.commit_sha256 == self.commit_sha256
            && receipt.projection_sha256.len() == 32
    }
}

struct TransferExpectation {
    session_id: String,
    source_generation: i32,
    activated_authority: Option<wire::SessionStoreAuthority>,
    verified_manifest_sha256: Vec<u8>,
}

impl TransferExpectation {
    fn matches(&self, receipt: &wire::SessionStorageTransferred) -> bool {
        receipt.session_id == self.session_id
            && receipt.source_generation == self.source_generation
            && receipt.activated_authority == self.activated_authority
            && receipt.verified_manifest_sha256 == self.verified_manifest_sha256
            && receipt.activation_receipt_sha256.len() == 32
    }
}

fn extension_failure(error: SessionStoreExtensionError) -> wire::SessionStoreResponse {
    let (code, reason_code, retryable) = match error {
        SessionStoreExtensionError::Unsupported => (
            wire::SessionStoreFailureCode::UnsupportedOperation,
            "native_extension_unavailable",
            false,
        ),
        SessionStoreExtensionError::Rejected => (
            wire::SessionStoreFailureCode::InvalidRequest,
            "native_extension_rejected",
            false,
        ),
        SessionStoreExtensionError::Internal => (
            wire::SessionStoreFailureCode::Internal,
            "native_extension_internal",
            true,
        ),
        SessionStoreExtensionError::Store(error) => return from_store(&error),
    };
    wire::SessionStoreResponse {
        body: Some(wire::session_store_response::Body::Failure(
            wire::SessionStoreFailure {
                code: code.into(),
                reason_code: reason_code.to_owned(),
                redacted_detail: None,
                retryable,
            },
        )),
    }
}
