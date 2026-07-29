use std::path::Path;

use agent_protocol::generated::v1 as wire;
use agent_session_store::{
    LegacyStorageTransferRequest, LegacyTransferLimits, SessionId, transfer_typescript_bundle,
};

use crate::convert::authority_from_wire;
use crate::{SessionStoreExtensionError, SessionStoreExtensionPort};

#[derive(Debug)]
pub struct FilesystemSessionStoreExtensionPort {
    transfer_limits: LegacyTransferLimits,
}

impl FilesystemSessionStoreExtensionPort {
    #[must_use]
    pub const fn new(transfer_limits: LegacyTransferLimits) -> Self {
        Self { transfer_limits }
    }
}

impl SessionStoreExtensionPort for FilesystemSessionStoreExtensionPort {
    fn publish_projection(
        &mut self,
        _request: wire::PublishSessionProjection,
    ) -> Result<wire::SessionProjectionPublished, SessionStoreExtensionError> {
        Err(SessionStoreExtensionError::Unsupported)
    }

    fn transfer_storage(
        &mut self,
        root: &Path,
        request: wire::TransferSessionStorageGeneration,
    ) -> Result<wire::SessionStorageTransferred, SessionStoreExtensionError> {
        let session_id = SessionId::parse(request.session_id.clone())
            .map_err(SessionStoreExtensionError::Store)?;
        let authority = authority_from_wire(request.next_authority.clone())
            .map_err(SessionStoreExtensionError::Store)?;
        let manifest = request
            .verified_manifest_sha256
            .as_slice()
            .try_into()
            .map_err(|_| SessionStoreExtensionError::Rejected)?;
        let receipt = transfer_typescript_bundle(
            root,
            &LegacyStorageTransferRequest {
                session_id,
                expected_source_lease_epoch: request.expected_source_lease_epoch,
                next_authority: authority,
                verified_manifest_sha256: manifest,
                idempotency_key: request.idempotency_key,
            },
            self.transfer_limits,
        )
        .map_err(SessionStoreExtensionError::Store)?;
        Ok(wire::SessionStorageTransferred {
            session_id: receipt.session_id.as_str().to_owned(),
            source_generation: wire::StorageGeneration::TypescriptFsV1.into(),
            activated_authority: request.next_authority,
            verified_manifest_sha256: receipt.verified_manifest_sha256.to_vec(),
            activation_receipt_sha256: receipt.activation_receipt_sha256.to_vec(),
            replay: receipt.replay,
        })
    }
}
