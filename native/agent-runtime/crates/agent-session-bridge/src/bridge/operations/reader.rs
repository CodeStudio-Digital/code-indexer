use agent_protocol::generated::v1 as wire;
use agent_session_store::{SessionId, SessionReadView, SessionStoreError};

use super::super::{AuthenticatedSessionStoreBridge, ReaderEntry};
use super::from_store;
use crate::SessionRootId;
use crate::convert::{authority_from_wire, authority_to_wire, limits_from_wire, state_to_wire};

impl AuthenticatedSessionStoreBridge {
    pub(super) fn open_reader(
        &mut self,
        request: wire::OpenSessionReader,
    ) -> wire::SessionStoreResponse {
        let parsed = (|| {
            if self.readers.len() >= 16 {
                return Err(SessionStoreError::InvalidLimits);
            }
            let root_id = SessionRootId::parse(&request.root_id)
                .map_err(|_| SessionStoreError::InvalidRoot)?;
            let root = self
                .roots
                .get(&root_id)
                .ok_or(SessionStoreError::InvalidRoot)?;
            let session_id = SessionId::parse(request.session_id)?;
            let limits = limits_from_wire(request.limits)?;
            let view = if request.authority.is_some() {
                SessionReadView::open(
                    root,
                    session_id.clone(),
                    &authority_from_wire(request.authority)?,
                    limits,
                )?
            } else {
                SessionReadView::open_current(root, session_id.clone(), limits)?
            };
            let snapshot = view.snapshot()?;
            let authority = snapshot.authority().clone();
            let state = state_to_wire(&snapshot);
            let snapshot_id = view.snapshot_id().to_owned();
            let handle = self.next_handle()?.replacen("writer:", "reader:", 1);
            self.readers.insert(
                handle.clone(),
                ReaderEntry {
                    session_id,
                    authority,
                    view,
                },
            );
            Ok(wire::SessionStoreResponse {
                body: Some(wire::session_store_response::Body::SessionReaderOpened(
                    wire::SessionReaderOpened {
                        reader_handle: handle,
                        state: Some(state),
                        snapshot_id,
                    },
                )),
            })
        })();
        parsed.unwrap_or_else(|error| from_store(&error))
    }

    pub(super) fn close_reader(
        &mut self,
        request: wire::CloseSessionReader,
    ) -> wire::SessionStoreResponse {
        let parsed = (|| {
            let authority = authority_from_wire(request.authority)?;
            let entry = self
                .readers
                .get(&request.reader_handle)
                .ok_or(SessionStoreError::StaleAuthority)?;
            if entry.authority != authority {
                return Err(SessionStoreError::StaleAuthority);
            }
            let entry = self
                .readers
                .remove(&request.reader_handle)
                .expect("reader checked above");
            Ok(wire::SessionStoreResponse {
                body: Some(wire::session_store_response::Body::SessionReaderClosed(
                    wire::SessionReaderClosed {
                        session_id: entry.session_id.as_str().to_owned(),
                        authority: Some(authority_to_wire(&authority)),
                    },
                )),
            })
        })();
        parsed.unwrap_or_else(|error| from_store(&error))
    }

    pub(super) fn query_reader(
        &self,
        request: wire::QuerySessionState,
    ) -> wire::SessionStoreResponse {
        let parsed = (|| {
            if !request.writer_handle.is_empty() {
                return Err(SessionStoreError::InvalidLimits);
            }
            let authority = authority_from_wire(request.authority)?;
            let entry = self
                .readers
                .get(&request.reader_handle)
                .ok_or(SessionStoreError::StaleAuthority)?;
            if entry.authority != authority {
                return Err(SessionStoreError::StaleAuthority);
            }
            Ok(wire::SessionStoreResponse {
                body: Some(wire::session_store_response::Body::SessionState(
                    state_to_wire(&entry.view.snapshot()?),
                )),
            })
        })();
        parsed.unwrap_or_else(|error| from_store(&error))
    }
}
