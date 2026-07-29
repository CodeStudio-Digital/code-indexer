use std::fmt::Debug;
use std::path::Path;

use agent_protocol::generated::v1 as wire;
use agent_session_store::SessionStoreError;

#[derive(Debug)]
pub enum SessionStoreExtensionError {
    Unsupported,
    Rejected,
    Internal,
    Store(SessionStoreError),
}

/// Rust-only seam for operations implemented in later storage phases.
///
/// Implementations are compiled into the native bridge and never supplied by
/// TypeScript.
pub trait SessionStoreExtensionPort: Debug + Send {
    /// # Errors
    ///
    /// Returns a typed failure when projection publication cannot be proven.
    fn publish_projection(
        &mut self,
        request: wire::PublishSessionProjection,
    ) -> Result<wire::SessionProjectionPublished, SessionStoreExtensionError>;

    /// # Errors
    ///
    /// Returns a typed failure when generation transfer cannot be proven.
    fn transfer_storage(
        &mut self,
        root: &Path,
        request: wire::TransferSessionStorageGeneration,
    ) -> Result<wire::SessionStorageTransferred, SessionStoreExtensionError>;
}

#[derive(Debug, Default)]
pub struct RejectingSessionStoreExtensionPort;

impl SessionStoreExtensionPort for RejectingSessionStoreExtensionPort {
    fn publish_projection(
        &mut self,
        _request: wire::PublishSessionProjection,
    ) -> Result<wire::SessionProjectionPublished, SessionStoreExtensionError> {
        Err(SessionStoreExtensionError::Unsupported)
    }

    fn transfer_storage(
        &mut self,
        _root: &Path,
        _request: wire::TransferSessionStorageGeneration,
    ) -> Result<wire::SessionStorageTransferred, SessionStoreExtensionError> {
        Err(SessionStoreExtensionError::Unsupported)
    }
}
