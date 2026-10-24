use std::collections::HashMap;
use std::fmt::{self, Debug, Formatter};
use std::path::PathBuf;

use agent_session_store::{
    SessionId, SessionJournal, SessionReadView, StorageAuthority, StorageRootLock,
};

use crate::config::{BridgeInstanceId, SessionRootId};
use crate::frame::{decode_request, encode_response};
use crate::{SessionStoreBridgeError, SessionStoreExtensionPort};

mod extensions;
mod failure;
mod operations;

struct WriterEntry {
    root_id: SessionRootId,
    open_idempotency_key: String,
    session_id: SessionId,
    authority: StorageAuthority,
    journal: SessionJournal,
}

struct ReaderEntry {
    session_id: SessionId,
    authority: StorageAuthority,
    view: SessionReadView,
}

pub struct AuthenticatedSessionStoreBridge {
    instance_id: BridgeInstanceId,
    bound_process_id: u32,
    max_frame_bytes: usize,
    next_request_sequence: u64,
    next_writer_handle: u64,
    roots: HashMap<SessionRootId, PathBuf>,
    writers: HashMap<String, WriterEntry>,
    readers: HashMap<String, ReaderEntry>,
    root_locks: HashMap<String, StorageRootLock>,
    extensions: Box<dyn SessionStoreExtensionPort>,
    poisoned: bool,
}

impl AuthenticatedSessionStoreBridge {
    pub(super) fn new(
        instance_id: BridgeInstanceId,
        max_frame_bytes: usize,
        roots: HashMap<SessionRootId, PathBuf>,
        extensions: Box<dyn SessionStoreExtensionPort>,
    ) -> Self {
        Self {
            instance_id,
            bound_process_id: std::process::id(),
            max_frame_bytes,
            next_request_sequence: 1,
            next_writer_handle: 1,
            roots,
            writers: HashMap::new(),
            readers: HashMap::new(),
            root_locks: HashMap::new(),
            extensions,
            poisoned: false,
        }
    }

    /// Handles one generated Protobuf request through this opaque owner.
    ///
    /// # Errors
    ///
    /// Framing, authentication, sequence, deadline, or response-bound failures
    /// poison the owner. Domain failures are returned as typed wire responses.
    pub fn handle(
        &mut self,
        encoded_frame: &[u8],
        now_unix_ms: i64,
    ) -> Result<Vec<u8>, SessionStoreBridgeError> {
        if self.poisoned {
            return Err(SessionStoreBridgeError::Poisoned);
        }
        if std::process::id() != self.bound_process_id {
            self.poisoned = true;
            return Err(SessionStoreBridgeError::ProcessIdentityMismatch);
        }
        let verified = match decode_request(
            encoded_frame,
            &self.instance_id,
            self.next_request_sequence,
            now_unix_ms,
            self.max_frame_bytes,
        ) {
            Ok(request) => request,
            Err(error) => {
                self.poisoned = true;
                return Err(error);
            }
        };
        self.next_request_sequence = verified
            .sequence
            .checked_add(1)
            .ok_or_else(|| self.poison(SessionStoreBridgeError::InvalidSequence))?;
        let response = self.dispatch(verified.request);
        encode_response(
            &self.instance_id,
            verified.request_id,
            verified.sequence,
            now_unix_ms,
            &response,
            self.max_frame_bytes,
        )
        .map_err(|error| self.poison(error))
    }

    #[must_use]
    pub fn active_writer_count(&self) -> usize {
        self.writers.len()
    }

    const fn poison(&mut self, error: SessionStoreBridgeError) -> SessionStoreBridgeError {
        self.poisoned = true;
        error
    }

    fn next_handle(&mut self) -> Result<String, agent_session_store::SessionStoreError> {
        let handle = format!(
            "writer:{}:{}",
            self.instance_id.as_str(),
            self.next_writer_handle
        );
        self.next_writer_handle = self
            .next_writer_handle
            .checked_add(1)
            .ok_or(agent_session_store::SessionStoreError::SequenceOverflow)?;
        Ok(handle)
    }
}

impl Debug for AuthenticatedSessionStoreBridge {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthenticatedSessionStoreBridge")
            .field("instance_id", &self.instance_id)
            .field("bound_process_id", &self.bound_process_id)
            .field("max_frame_bytes", &self.max_frame_bytes)
            .field("next_request_sequence", &self.next_request_sequence)
            .field("next_writer_handle", &self.next_writer_handle)
            .field("root_count", &self.roots.len())
            .field("active_writer_count", &self.writers.len())
            .field("readers", &self.readers.len())
            .field("root_locks", &self.root_locks.len())
            .field("extensions", &self.extensions)
            .field("poisoned", &self.poisoned)
            .finish()
    }
}
