use agent_lifecycle_store::DurableLifecycleOutbox;
use agent_protocol::generated::v1 as wire;
use agent_session_store::SessionStoreError;
use sha2::{Digest, Sha256};
use std::fmt::Write;

use super::super::AuthenticatedSessionStoreBridge;
use super::super::failure::from_store;
use crate::SessionRootId;

impl AuthenticatedSessionStoreBridge {
    pub(super) fn inspect_lifecycle(
        &self,
        request: &wire::InspectSupervisorLifecycleEvidence,
    ) -> wire::SessionStoreResponse {
        let result = (|| {
            if request.connection_id.is_empty()
                || request.connection_id.len() > 512
                || request.attempt_id.is_empty()
                || request.attempt_id.len() > 512
            {
                return Err(SessionStoreError::InvalidOperationId);
            }
            let root_id = SessionRootId::parse(&request.root_id)
                .map_err(|_| SessionStoreError::InvalidRoot)?;
            let root = self
                .roots
                .get(&root_id)
                .ok_or(SessionStoreError::InvalidRoot)?;
            let root = root.canonicalize().map_err(map_io)?;
            let digest = Sha256::digest(request.connection_id.as_bytes());
            let mut namespace = String::with_capacity(64);
            for byte in digest {
                write!(&mut namespace, "{byte:02x}").expect("writing to String");
            }
            let directory = root.join(".supervisor-outbox").join(namespace);
            if directory.canonicalize().map_err(map_io)? != directory {
                return Err(SessionStoreError::UnsafePath);
            }
            let entry = DurableLifecycleOutbox::inspect(
                &directory,
                &request.connection_id,
                &request.attempt_id,
            )
            .map_err(map_io)?;
            Ok(wire::SessionStoreResponse {
                body: Some(
                    wire::session_store_response::Body::SupervisorLifecycleEvidenceInspected(
                        wire::SupervisorLifecycleEvidenceInspected { entry },
                    ),
                ),
            })
        })();
        result.unwrap_or_else(|error| from_store(&error))
    }
}

fn map_io(error: std::io::Error) -> SessionStoreError {
    match error.kind() {
        std::io::ErrorKind::WouldBlock => SessionStoreError::StorageLockBusy,
        std::io::ErrorKind::InvalidData => SessionStoreError::CorruptJournal,
        std::io::ErrorKind::NotFound => SessionStoreError::MissingPayload,
        _ => SessionStoreError::Io {
            action: "inspect supervisor lifecycle evidence",
            source: error,
        },
    }
}
