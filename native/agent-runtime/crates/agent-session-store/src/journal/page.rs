use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use super::{CommitReceipt, SessionJournal};
use crate::{SessionStoreError, layout::SessionBundleLayout};

pub const MAX_COMMITTED_RECORD_PAGE: u32 = 256;
// A snapshot is an immutable prefix of the writer's validated commit index.
// Payloads still require exact, content-addressed reads.
const MAX_SNAPSHOT_RECORDS: usize = 100_000;
static NEXT_SNAPSHOT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, PartialEq, Eq)]
pub(super) struct JournalStamp {
    pub(super) bytes: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
}

#[derive(Debug)]
pub(super) struct ValidatedRecordSnapshot {
    id: String,
    count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListCommittedRecordsRequest {
    pub after_sequence: u64,
    pub maximum_records: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommittedRecordPage {
    records: Vec<CommitReceipt>,
    next_sequence: u64,
    complete: bool,
    snapshot_id: String,
}

impl CommittedRecordPage {
    pub(crate) const fn from_snapshot(
        records: Vec<CommitReceipt>,
        next_sequence: u64,
        complete: bool,
        snapshot_id: String,
    ) -> Self {
        Self {
            records,
            next_sequence,
            complete,
            snapshot_id,
        }
    }
    #[must_use]
    pub fn snapshot_id(&self) -> &str {
        &self.snapshot_id
    }

    #[must_use]
    pub fn records(&self) -> &[CommitReceipt] {
        &self.records
    }

    #[must_use]
    pub const fn next_sequence(&self) -> u64 {
        self.next_sequence
    }

    #[must_use]
    pub const fn complete(&self) -> bool {
        self.complete
    }
}

impl SessionJournal {
    /// Returns a bounded metadata page from the writer's validated commit index.
    /// Payload bytes remain content-addressed and require a separate exact read.
    ///
    /// # Errors
    ///
    /// Fails closed on invalid cursor bounds, stale authority, external
    /// mutation or any sequence/hash-chain divergence.
    pub fn list_committed_records(
        &mut self,
        request: ListCommittedRecordsRequest,
    ) -> Result<CommittedRecordPage, SessionStoreError> {
        self.list_committed_snapshot(request, "")
    }

    /// Freezes the current committed prefix for an empty id, then pages it.
    /// Authorized appends preserve the frozen page set. Reopen, lost authority
    /// or unexpected source changes invalidate the id.
    ///
    /// # Errors
    /// Fails closed on an unknown snapshot or unexpected journal mutation.
    pub fn list_committed_snapshot(
        &mut self,
        request: ListCommittedRecordsRequest,
        snapshot_id: &str,
    ) -> Result<CommittedRecordPage, SessionStoreError> {
        if self.poisoned {
            return Err(SessionStoreError::Poisoned);
        }
        if request.maximum_records == 0
            || request.maximum_records > MAX_COMMITTED_RECORD_PAGE
            || request.after_sequence > self.state.count
        {
            return Err(SessionStoreError::InvalidLimits);
        }
        self.verify_authority()?;
        self.verify_journal_length()?;
        self.verify_snapshot_source()?;
        if snapshot_id.is_empty() {
            let count = self.state.records.len();
            if count > MAX_SNAPSHOT_RECORDS {
                return Err(SessionStoreError::RecordLimitExceeded);
            }
            let nonce = NEXT_SNAPSHOT_ID
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                    value.checked_add(1)
                })
                .map_err(|_| SessionStoreError::SequenceOverflow)?;
            let id = format!(
                "{}:{}:{}",
                self.authority.writer_id().as_str(),
                self.authority.lease_epoch().get(),
                nonce
            );
            self.page_snapshot = Some(ValidatedRecordSnapshot { id, count });
        } else if self
            .page_snapshot
            .as_ref()
            .is_none_or(|snapshot| snapshot.id != snapshot_id)
        {
            self.page_snapshot = None;
            return Err(SessionStoreError::ConcurrentMutation);
        }
        let snapshot = self
            .page_snapshot
            .as_ref()
            .ok_or(SessionStoreError::ConcurrentMutation)?;
        let start = usize::try_from(request.after_sequence)
            .map_err(|_| SessionStoreError::InvalidLimits)?;
        if start > snapshot.count {
            return Err(SessionStoreError::InvalidLimits);
        }
        let end = start
            .saturating_add(request.maximum_records as usize)
            .min(snapshot.count);
        let records = self.state.records[start..end].to_vec();
        let next_sequence = records
            .last()
            .map_or(request.after_sequence, CommitReceipt::sequence);
        Ok(CommittedRecordPage {
            records,
            next_sequence,
            complete: end == snapshot.count,
            snapshot_id: snapshot.id.clone(),
        })
    }

    pub(super) fn verify_snapshot_source(&mut self) -> Result<(), SessionStoreError> {
        if self.journal_source != journal_stamp(&self.layout)? {
            self.poisoned = true;
            self.page_snapshot = None;
            return Err(SessionStoreError::ConcurrentMutation);
        }
        Ok(())
    }

    pub(super) fn refresh_snapshot_source(&mut self) -> Result<(), SessionStoreError> {
        self.journal_source = journal_stamp(&self.layout).inspect_err(|_| {
            self.poisoned = true;
        })?;
        Ok(())
    }
}

pub(super) fn journal_stamp(
    layout: &SessionBundleLayout,
) -> Result<JournalStamp, SessionStoreError> {
    crate::layout::validate_regular_file(&layout.journal())?;
    let metadata = std::fs::metadata(layout.journal())
        .map_err(|error| SessionStoreError::io("inspect journal snapshot", error))?;
    Ok(JournalStamp {
        bytes: metadata.len(),
        modified: metadata
            .modified()
            .map_err(|error| SessionStoreError::io("inspect journal modification", error))?,
        created: metadata.created().ok(),
    })
}
