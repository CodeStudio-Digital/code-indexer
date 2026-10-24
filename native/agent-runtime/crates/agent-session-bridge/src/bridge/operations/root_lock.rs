use agent_protocol::generated::v1 as wire;
use agent_session_store::{SessionStoreError, StorageRootLock};

use super::super::AuthenticatedSessionStoreBridge;
use super::super::failure::from_store;
use crate::SessionRootId;

impl AuthenticatedSessionStoreBridge {
    pub(super) fn acquire_root_lock(
        &mut self,
        request: &wire::AcquireStorageRootLock,
    ) -> wire::SessionStoreResponse {
        let result = (|| {
            if self.root_locks.len() >= 16 {
                return Err(SessionStoreError::RecordLimitExceeded);
            }
            let root_id = SessionRootId::parse(&request.root_id)
                .map_err(|_| SessionStoreError::InvalidRoot)?;
            let root = self
                .roots
                .get(&root_id)
                .ok_or(SessionStoreError::InvalidRoot)?;
            let lock = StorageRootLock::acquire(root, &request.lock_name)?;
            let handle = self.next_handle()?;
            self.root_locks.insert(handle.clone(), lock);
            Ok(wire::SessionStoreResponse {
                body: Some(wire::session_store_response::Body::StorageRootLockAcquired(
                    wire::StorageRootLockAcquired {
                        lock_handle: handle,
                    },
                )),
            })
        })();
        result.unwrap_or_else(|error| from_store(&error))
    }

    pub(super) fn release_root_lock(
        &mut self,
        request: wire::ReleaseStorageRootLock,
    ) -> wire::SessionStoreResponse {
        if self.root_locks.remove(&request.lock_handle).is_none() {
            return from_store(&SessionStoreError::StaleAuthority);
        }
        wire::SessionStoreResponse {
            body: Some(wire::session_store_response::Body::StorageRootLockReleased(
                wire::StorageRootLockReleased {
                    lock_handle: request.lock_handle,
                },
            )),
        }
    }
}
