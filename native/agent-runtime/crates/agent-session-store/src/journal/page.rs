use std::fs::File;
use std::io::{BufRead, BufReader};

use super::{CommitReceipt, SessionJournal};
use crate::SessionStoreError;
use crate::record::{JournalRecord, MAX_JOURNAL_LINE_BYTES};

pub const MAX_COMMITTED_RECORD_PAGE: u32 = 256;

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
}

impl CommittedRecordPage {
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
    /// Returns a bounded metadata page after validating the entire live chain.
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
        if request.maximum_records == 0
            || request.maximum_records > MAX_COMMITTED_RECORD_PAGE
            || request.after_sequence > self.state.count
        {
            return Err(SessionStoreError::InvalidLimits);
        }
        self.verify_authority()?;
        self.verify_journal_length()?;
        let mut reader = BufReader::new(
            File::open(self.layout.journal())
                .map_err(|error| SessionStoreError::io("open session journal page", error))?,
        );
        let capacity = usize::try_from(request.maximum_records)
            .map_err(|_| SessionStoreError::InvalidLimits)?;
        let mut records = Vec::with_capacity(capacity);
        let mut count = 0_u64;
        let mut previous_hash = JournalRecord::first_previous_hash();
        let mut journal_bytes = 0_u64;
        let mut line = Vec::with_capacity(MAX_JOURNAL_LINE_BYTES);
        loop {
            line.clear();
            let bytes = reader
                .read_until(b'\n', &mut line)
                .map_err(|error| SessionStoreError::io("read session journal page", error))?;
            if bytes == 0 {
                break;
            }
            if line.len() > MAX_JOURNAL_LINE_BYTES || !line.ends_with(b"\n") {
                return Err(SessionStoreError::CorruptJournal);
            }
            let record = JournalRecord::parse(&line)?;
            count = count
                .checked_add(1)
                .ok_or(SessionStoreError::SequenceOverflow)?;
            if record.sequence != count || record.previous_hash != previous_hash {
                return Err(SessionStoreError::CorruptJournal);
            }
            if record.sequence > request.after_sequence && records.len() < capacity {
                records.push(CommitReceipt::from_record(&self.session_id, &record));
            }
            previous_hash = record.record_hash;
            journal_bytes = journal_bytes
                .checked_add(u64::try_from(bytes).map_err(|_| SessionStoreError::CorruptJournal)?)
                .ok_or(SessionStoreError::CorruptJournal)?;
        }
        if count != self.state.count
            || previous_hash != self.state.previous_hash
            || journal_bytes != self.state.journal_bytes
        {
            return Err(SessionStoreError::ConcurrentMutation);
        }
        let next_sequence = records
            .last()
            .map_or(request.after_sequence, CommitReceipt::sequence);
        Ok(CommittedRecordPage {
            records,
            next_sequence,
            complete: next_sequence == self.state.count,
        })
    }
}
