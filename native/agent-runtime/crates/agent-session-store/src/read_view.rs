use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use crate::layout::{SessionBundleLayout, validate_regular_file};
use crate::{
    CommitReceipt, CommittedPayload, CommittedRecordPage, ListCommittedRecordsRequest,
    MAX_COMMITTED_RECORD_PAGE, OperationId, ReadCommittedPayloadRequest, SessionId,
    SessionStateSnapshot, SessionStoreError, SessionStoreLimits, StorageAuthority,
};

static NEXT_READER: AtomicU64 = AtomicU64::new(1);
// Matches the product writer's bounded admission. Each tool turn contributes
// multiple records; the immutable reader still validates the chain only once.
const MAX_READ_RECORDS: u64 = 1_000_000;

#[derive(Debug, PartialEq, Eq)]
struct SourceStamp(Vec<(u64, SystemTime, Option<SystemTime>)>);

/// An immutable, validated read capability. Opening never creates a bundle,
/// repairs a tail, acquires a writer lease or advances storage authority.
#[derive(Debug)]
pub struct SessionReadView {
    layout: SessionBundleLayout,
    stamp: SourceStamp,
    snapshot: SessionStateSnapshot,
    records: Vec<CommitReceipt>,
    operations: HashMap<OperationId, usize>,
    snapshot_id: String,
    maximum_payload_bytes: u64,
}

impl SessionReadView {
    /// Validates the authority chain, committed journal and payload graph once.
    /// # Errors
    /// Rejects stale authority, corruption, concurrent change and bounded limits.
    pub fn open(
        root: &Path,
        session_id: SessionId,
        expected: &StorageAuthority,
        limits: SessionStoreLimits,
    ) -> Result<Self, SessionStoreError> {
        Self::open_checked(root, session_id, Some(expected), limits)
    }

    /// Reads the current authority from its validated chain. This remains a
    /// read capability and never grants or advances writer authority.
    /// # Errors
    /// Rejects corruption, concurrent changes and limits exceeded during validation.
    pub fn open_current(
        root: &Path,
        session_id: SessionId,
        limits: SessionStoreLimits,
    ) -> Result<Self, SessionStoreError> {
        Self::open_checked(root, session_id, None, limits)
    }

    fn open_checked(
        root: &Path,
        session_id: SessionId,
        expected: Option<&StorageAuthority>,
        limits: SessionStoreLimits,
    ) -> Result<Self, SessionStoreError> {
        let layout = SessionBundleLayout::open_existing(root, &session_id)?;
        let stamp = source_stamp(&layout)?;
        crate::manifest::validate_manifest(&layout, &session_id)?;
        let limits = SessionStoreLimits::new(
            limits.max_records().min(MAX_READ_RECORDS),
            limits.max_payload_bytes(),
            limits.max_authority_transitions(),
        )?;
        let authority = crate::authority_log::read_history(&layout.authority_log(), limits)?;
        let current = authority
            .current()
            .ok_or(SessionStoreError::CorruptAuthority)?;
        if expected.is_some_and(|expected| expected != current) {
            return Err(SessionStoreError::StaleAuthority);
        }
        let recovered = crate::recovery::read_committed(&layout, &session_id, limits, &authority)?;
        if stamp != source_stamp(&layout)? {
            return Err(SessionStoreError::ConcurrentMutation);
        }
        // Recovery already checked contiguous order and duplicate identities.
        // Move its index into the view: no second full index or sort is needed.
        let records = recovered.records;
        let operations = recovered.operations;
        let nonce = NEXT_READER
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| SessionStoreError::SequenceOverflow)?;
        let snapshot_id = format!(
            "read:{}:{}:{nonce}",
            session_id.as_str(),
            current.lease_epoch().get()
        );
        let snapshot = SessionStateSnapshot::new(
            session_id,
            current.clone(),
            recovered.count,
            recovered.previous_hash,
            recovered.archived,
        );
        Ok(Self {
            layout,
            stamp,
            snapshot,
            records,
            operations,
            snapshot_id,
            maximum_payload_bytes: limits.max_payload_bytes(),
        })
    }

    /// # Errors
    /// Rejects any source change since the view was validated.
    pub fn snapshot(&self) -> Result<SessionStateSnapshot, SessionStoreError> {
        self.verify_source()?;
        Ok(self.snapshot.clone())
    }

    #[must_use]
    pub fn snapshot_id(&self) -> &str {
        &self.snapshot_id
    }

    /// # Errors
    /// Rejects foreign snapshots, out-of-range cursors or changed sources.
    pub fn list(
        &self,
        request: ListCommittedRecordsRequest,
        snapshot_id: &str,
    ) -> Result<CommittedRecordPage, SessionStoreError> {
        self.verify_source()?;
        if (!snapshot_id.is_empty() && snapshot_id != self.snapshot_id)
            || request.maximum_records == 0
            || request.maximum_records > MAX_COMMITTED_RECORD_PAGE
        {
            return Err(SessionStoreError::InvalidLimits);
        }
        let start = usize::try_from(request.after_sequence)
            .map_err(|_| SessionStoreError::InvalidLimits)?;
        if start > self.records.len() {
            return Err(SessionStoreError::InvalidLimits);
        }
        let end = start
            .saturating_add(request.maximum_records as usize)
            .min(self.records.len());
        let records = self.records[start..end].to_vec();
        let next = records
            .last()
            .map_or(request.after_sequence, CommitReceipt::sequence);
        Ok(CommittedRecordPage::from_snapshot(
            records,
            next,
            end == self.records.len(),
            self.snapshot_id.clone(),
        ))
    }

    /// # Errors
    /// Only exact receipts in this snapshot authorize a payload read.
    pub fn read(
        &self,
        request: ReadCommittedPayloadRequest<'_>,
    ) -> Result<CommittedPayload, SessionStoreError> {
        self.verify_source()?;
        if request.expected_payload_bytes
            > self
                .maximum_payload_bytes
                .min(request.maximum_payload_bytes)
        {
            return Err(SessionStoreError::PayloadLimitExceeded);
        }
        let receipt = self
            .operations
            .get(request.operation_id)
            .and_then(|index| self.records.get(*index))
            .ok_or(SessionStoreError::MissingPayload)?;
        if receipt.kind() != request.kind
            || receipt.payload_hash() != request.expected_payload_sha256
            || receipt.payload_bytes() != request.expected_payload_bytes
        {
            return Err(SessionStoreError::DivergentReplay);
        }
        let bytes = crate::payload::read_payload(
            &self.layout,
            request.kind,
            &request.expected_payload_sha256,
            request.expected_payload_bytes,
            request.maximum_payload_bytes,
        )?;
        self.verify_source()?;
        Ok(CommittedPayload::new(receipt.clone(), bytes))
    }

    fn verify_source(&self) -> Result<(), SessionStoreError> {
        if self.stamp != source_stamp(&self.layout)? {
            return Err(SessionStoreError::ConcurrentMutation);
        }
        Ok(())
    }
}

fn source_stamp(layout: &SessionBundleLayout) -> Result<SourceStamp, SessionStoreError> {
    let mut stamps = Vec::with_capacity(3);
    for path in [layout.manifest(), layout.authority_log(), layout.journal()] {
        validate_regular_file(&path)?;
        let metadata = std::fs::metadata(path)
            .map_err(|error| SessionStoreError::io("inspect read snapshot", error))?;
        stamps.push((
            metadata.len(),
            metadata
                .modified()
                .map_err(|error| SessionStoreError::io("inspect read snapshot time", error))?,
            metadata.created().ok(),
        ));
    }
    Ok(SourceStamp(stamps))
}
