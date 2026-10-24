use std::fs::{File, OpenOptions};
use std::path::Path;

use crate::authority_log::{activate, activate_transferred};
use crate::hash::{ContentHash, sha256};
use crate::layout::SessionBundleLayout;
use crate::lease::WriterLease;
use crate::manifest::ensure_manifest;
use crate::payload::commit_payload;
use crate::record::{JournalRecord, JournalRecordInput};
use crate::recovery::{RecoveredJournal, recover};
use crate::{
    DurabilityClass, SessionId, SessionRecordKind, SessionStateSnapshot, SessionStoreError,
    SessionStoreLimits, StorageAuthority,
};

mod committed_payload;
mod io;
mod page;
mod receipt;
pub use page::{CommittedRecordPage, ListCommittedRecordsRequest, MAX_COMMITTED_RECORD_PAGE};
use receipt::replay;
pub use receipt::{AppendRequest, CommitOutcome, CommitReceipt};

#[derive(Debug)]
pub struct SessionJournal {
    session_id: SessionId,
    authority: StorageAuthority,
    authority_log_bytes: u64,
    layout: SessionBundleLayout,
    limits: SessionStoreLimits,
    lease: WriterLease,
    file: File,
    state: RecoveredJournal,
    poisoned: bool,
    page_snapshot: Option<page::ValidatedRecordSnapshot>,
    journal_source: page::JournalStamp,
}

impl SessionJournal {
    /// Opens the only active writer for a session and recovers its journal.
    ///
    /// # Errors
    ///
    /// Fails closed on unsafe paths, a live writer, corrupt history, missing
    /// payloads, or records outside configured limits.
    pub fn open(
        root: &Path,
        session_id: SessionId,
        authority: StorageAuthority,
        limits: SessionStoreLimits,
    ) -> Result<Self, SessionStoreError> {
        Self::open_inner(root, session_id, authority, limits, false)
    }

    pub(crate) fn open_transferred(
        root: &Path,
        session_id: SessionId,
        authority: StorageAuthority,
        limits: SessionStoreLimits,
    ) -> Result<Self, SessionStoreError> {
        Self::open_inner(root, session_id, authority, limits, true)
    }

    fn open_inner(
        root: &Path,
        session_id: SessionId,
        authority: StorageAuthority,
        limits: SessionStoreLimits,
        transferred: bool,
    ) -> Result<Self, SessionStoreError> {
        let layout = SessionBundleLayout::create(root, &session_id)?;
        ensure_manifest(&layout, &session_id)?;
        let lease = WriterLease::acquire(layout.lease(), &authority)?;
        let authorities = if transferred {
            activate_transferred(&layout, &authority, limits)?
        } else {
            activate(&layout, &authority, limits)?
        };
        let authority_log_bytes = authorities.log_bytes();
        let state = recover(&layout, &session_id, limits, &authorities)?;
        let journal_source = page::journal_stamp(&layout)?;
        if journal_source.bytes != state.journal_bytes {
            return Err(SessionStoreError::ConcurrentMutation);
        }
        let file = OpenOptions::new()
            .append(true)
            .open(layout.journal())
            .map_err(|error| SessionStoreError::io("open session journal writer", error))?;
        Ok(Self {
            session_id,
            authority,
            authority_log_bytes,
            layout,
            limits,
            lease,
            file,
            state,
            poisoned: false,
            page_snapshot: None,
            journal_source,
        })
    }

    /// Durably commits a bounded content-addressed record.
    /// # Errors
    ///
    /// Rejects divergent replay, exhausted limits, external mutation, or any
    /// I/O failure. An uncertain journal write poisons this owner.
    pub fn append(
        &mut self,
        request: AppendRequest<'_>,
    ) -> Result<CommitOutcome, SessionStoreError> {
        if self.poisoned {
            return Err(SessionStoreError::Poisoned);
        }
        self.verify_authority()?;
        self.verify_snapshot_source()?;
        let payload_bytes = u64::try_from(request.payload.len())
            .map_err(|_| SessionStoreError::PayloadLimitExceeded)?;
        if payload_bytes > self.limits.max_payload_bytes() {
            return Err(SessionStoreError::PayloadLimitExceeded);
        }
        let payload_hash = sha256(request.payload);
        if let Some(index) = self.state.operations.get(request.operation_id) {
            return replay(
                &self.state.records[*index],
                request.kind,
                request.durability,
                payload_hash,
                payload_bytes,
            );
        }
        if self.state.archived {
            return Err(SessionStoreError::SessionArchived);
        }
        if request.kind == SessionRecordKind::Archive
            && request.durability != DurabilityClass::Authoritative
        {
            return Err(SessionStoreError::ArchiveRequiresAuthoritativeDurability);
        }
        if self.state.count >= self.limits.max_records() {
            return Err(SessionStoreError::RecordLimitExceeded);
        }
        self.commit_new(request, payload_hash, payload_bytes)
    }

    #[must_use]
    pub const fn committed_records(&self) -> u64 {
        self.state.count
    }

    #[must_use]
    pub fn snapshot(&self) -> SessionStateSnapshot {
        SessionStateSnapshot::new(
            self.session_id.clone(),
            self.authority.clone(),
            self.state.count,
            self.state.previous_hash,
            self.state.archived,
        )
    }

    fn commit_new(
        &mut self,
        request: AppendRequest<'_>,
        payload_hash: ContentHash,
        payload_bytes: u64,
    ) -> Result<CommitOutcome, SessionStoreError> {
        commit_payload(
            &self.layout,
            request.kind,
            request.payload,
            &payload_hash,
            payload_bytes,
        )?;
        let sequence = self
            .state
            .count
            .checked_add(1)
            .ok_or(SessionStoreError::SequenceOverflow)?;
        let record = JournalRecord::new(JournalRecordInput {
            sequence,
            kind: request.kind,
            durability: request.durability,
            authority: self.authority.clone(),
            operation_id: request.operation_id.clone(),
            previous_hash: self.state.previous_hash,
            payload_hash,
            payload_bytes,
        });
        let encoded = record.encode();
        self.verify_journal_length()?;
        if let Err(error) = self.write_record(&encoded) {
            self.poisoned = true;
            return Err(error);
        }
        self.refresh_snapshot_source()?;
        let receipt = CommitReceipt::from_record(&self.session_id, &record);
        self.state.count = sequence;
        self.state.previous_hash = record.record_hash;
        self.state.journal_bytes = self
            .state
            .journal_bytes
            .checked_add(u64::try_from(encoded.len()).expect("journal record length fits u64"))
            .ok_or(SessionStoreError::SequenceOverflow)?;
        self.state
            .operations
            .insert(request.operation_id.clone(), self.state.records.len());
        self.state.records.push(receipt.clone());
        self.state.archived = request.kind == SessionRecordKind::Archive;
        Ok(CommitOutcome::Committed(receipt))
    }

    fn verify_authority(&mut self) -> Result<(), SessionStoreError> {
        if let Err(error) = self.lease.verify(&self.authority) {
            self.poisoned = true;
            return Err(error);
        }
        let length = std::fs::metadata(self.layout.authority_log())
            .map_err(|error| SessionStoreError::io("inspect storage authority log", error))?
            .len();
        if length != self.authority_log_bytes {
            self.poisoned = true;
            return Err(SessionStoreError::StaleAuthority);
        }
        Ok(())
    }
}
