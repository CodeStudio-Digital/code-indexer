use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read};

use crate::authority_log::AuthorityHistory;
use crate::hash::{ContentHash, sha256_reader};
use crate::layout::{SessionBundleLayout, validate_regular_file};
use crate::record::{JournalRecord, MAX_JOURNAL_LINE_BYTES};
use crate::{CommitReceipt, OperationId, SessionId, SessionStoreError, SessionStoreLimits};

#[derive(Debug)]
pub struct RecoveredJournal {
    pub(super) count: u64,
    pub(super) previous_hash: ContentHash,
    pub(super) journal_bytes: u64,
    pub(super) operations: HashMap<OperationId, usize>,
    /// Journal order, validated once on recovery and extended only by commits.
    pub(super) records: Vec<CommitReceipt>,
    pub(super) archived: bool,
}

pub fn recover(
    layout: &SessionBundleLayout,
    session_id: &SessionId,
    limits: SessionStoreLimits,
    authorities: &AuthorityHistory,
) -> Result<RecoveredJournal, SessionStoreError> {
    recover_inner(layout, session_id, limits, authorities, true)
}

pub fn read_committed(
    layout: &SessionBundleLayout,
    session_id: &SessionId,
    limits: SessionStoreLimits,
    authorities: &AuthorityHistory,
) -> Result<RecoveredJournal, SessionStoreError> {
    recover_inner(layout, session_id, limits, authorities, false)
}

fn recover_inner(
    layout: &SessionBundleLayout,
    session_id: &SessionId,
    limits: SessionStoreLimits,
    authorities: &AuthorityHistory,
    repair: bool,
) -> Result<RecoveredJournal, SessionStoreError> {
    let journal_path = layout.journal();
    if repair {
        ensure_journal(&journal_path)?;
    } else {
        validate_regular_file(&journal_path)?;
    }
    let mut reader = BufReader::new(
        File::open(&journal_path)
            .map_err(|error| SessionStoreError::io("open session journal", error))?,
    );
    let mut recovered = RecoveredJournal {
        count: 0,
        previous_hash: JournalRecord::first_previous_hash(),
        journal_bytes: 0,
        operations: HashMap::new(),
        records: Vec::new(),
        archived: false,
    };
    let mut line = Vec::with_capacity(MAX_JOURNAL_LINE_BYTES);
    loop {
        line.clear();
        let bytes = reader
            .by_ref()
            .take((MAX_JOURNAL_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|error| SessionStoreError::io("read session journal", error))?;
        if bytes == 0 {
            break;
        }
        if line.len() > MAX_JOURNAL_LINE_BYTES {
            return Err(SessionStoreError::CorruptJournal);
        }
        if !line.ends_with(b"\n") {
            if repair {
                truncate_tail(&journal_path, recovered.journal_bytes)?;
            }
            break;
        }
        apply_record(
            layout,
            session_id,
            limits,
            authorities,
            &mut recovered,
            &line,
        )?;
        recovered.journal_bytes = recovered
            .journal_bytes
            .checked_add(u64::try_from(bytes).map_err(|_| SessionStoreError::CorruptJournal)?)
            .ok_or(SessionStoreError::CorruptJournal)?;
    }
    Ok(recovered)
}

fn apply_record(
    layout: &SessionBundleLayout,
    session_id: &SessionId,
    limits: SessionStoreLimits,
    authorities: &AuthorityHistory,
    recovered: &mut RecoveredJournal,
    line: &[u8],
) -> Result<(), SessionStoreError> {
    if recovered.count >= limits.max_records() {
        return Err(SessionStoreError::RecordLimitExceeded);
    }
    let record = JournalRecord::parse(line)?;
    if recovered.archived {
        return Err(SessionStoreError::CorruptJournal);
    }
    if !authorities.matches(&record.authority) {
        return Err(SessionStoreError::CorruptJournal);
    }
    let expected_sequence = recovered
        .count
        .checked_add(1)
        .ok_or(SessionStoreError::SequenceOverflow)?;
    if record.sequence != expected_sequence || record.previous_hash != recovered.previous_hash {
        return Err(SessionStoreError::CorruptJournal);
    }
    if record.payload_bytes > limits.max_payload_bytes() {
        return Err(SessionStoreError::PayloadLimitExceeded);
    }
    verify_payload(layout, &record)?;
    let receipt = CommitReceipt::from_record(session_id, &record);
    if recovered
        .operations
        .insert(record.operation_id.clone(), recovered.records.len())
        .is_some()
    {
        return Err(SessionStoreError::CorruptJournal);
    }
    recovered.count = expected_sequence;
    recovered.records.push(receipt);
    recovered.previous_hash = record.record_hash;
    recovered.archived = record.kind == crate::SessionRecordKind::Archive;
    Ok(())
}

fn verify_payload(
    layout: &SessionBundleLayout,
    record: &JournalRecord,
) -> Result<(), SessionStoreError> {
    let path = layout.payload(record.kind, &record.payload_hash);
    match validate_regular_file(&path) {
        Ok(()) => {}
        Err(SessionStoreError::Io { source, .. })
            if source.kind() == std::io::ErrorKind::NotFound =>
        {
            return Err(SessionStoreError::MissingPayload);
        }
        Err(error) => return Err(error),
    }
    let mut file =
        File::open(path).map_err(|error| SessionStoreError::io("open session payload", error))?;
    let hash = sha256_reader(&mut file, record.payload_bytes)
        .map_err(|error| SessionStoreError::io("hash session payload", error))?;
    if hash != record.payload_hash {
        return Err(SessionStoreError::DivergentPayload);
    }
    Ok(())
}

fn ensure_journal(path: &std::path::Path) -> Result<(), SessionStoreError> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file
            .sync_all()
            .map_err(|error| SessionStoreError::io("sync new session journal", error)),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            validate_regular_file(path)
        }
        Err(error) => Err(SessionStoreError::io("create session journal", error)),
    }
}

fn truncate_tail(path: &std::path::Path, length: u64) -> Result<(), SessionStoreError> {
    let file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|error| SessionStoreError::io("open journal for tail recovery", error))?;
    file.set_len(length)
        .map_err(|error| SessionStoreError::io("truncate incomplete journal tail", error))?;
    file.sync_all()
        .map_err(|error| SessionStoreError::io("sync recovered session journal", error))?;
    let metadata = fs::metadata(path)
        .map_err(|error| SessionStoreError::io("inspect recovered session journal", error))?;
    if metadata.len() != length {
        return Err(SessionStoreError::ConcurrentMutation);
    }
    Ok(())
}
