use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};

use crate::hash::ContentHash;
use crate::layout::{SessionBundleLayout, validate_regular_file};
use crate::{SessionStoreError, SessionStoreLimits, StorageAuthority};

mod record;

use record::AuthorityRecord;

const MAX_AUTHORITY_LINE_BYTES: usize = 320;
const ZERO_HASH: ContentHash = [0; 32];

#[derive(Debug)]
pub struct AuthorityHistory {
    transitions: u64,
    previous_hash: ContentHash,
    log_bytes: u64,
    by_epoch: HashMap<u64, StorageAuthority>,
    current: Option<StorageAuthority>,
}

impl AuthorityHistory {
    pub(crate) const fn current(&self) -> Option<&StorageAuthority> {
        self.current.as_ref()
    }
    pub fn matches(&self, authority: &StorageAuthority) -> bool {
        self.by_epoch
            .get(&authority.lease_epoch().get())
            .is_some_and(|stored| stored == authority)
    }

    pub const fn log_bytes(&self) -> u64 {
        self.log_bytes
    }
}

pub fn activate(
    layout: &SessionBundleLayout,
    requested: &StorageAuthority,
    limits: SessionStoreLimits,
) -> Result<AuthorityHistory, SessionStoreError> {
    let path = layout.authority_log();
    ensure_log(&path)?;
    let history = recover(&path, limits)?;
    activate_recovered(&path, history, requested, limits, false)
}

pub fn activate_transferred(
    layout: &SessionBundleLayout,
    requested: &StorageAuthority,
    limits: SessionStoreLimits,
) -> Result<AuthorityHistory, SessionStoreError> {
    let path = layout.authority_log();
    ensure_log(&path)?;
    let history = recover(&path, limits)?;
    activate_recovered(&path, history, requested, limits, true)
}

fn activate_recovered(
    path: &std::path::Path,
    mut history: AuthorityHistory,
    requested: &StorageAuthority,
    limits: SessionStoreLimits,
    allow_transferred_initial_epoch: bool,
) -> Result<AuthorityHistory, SessionStoreError> {
    match history.current.as_ref() {
        None if requested.lease_epoch().get() == 1 || allow_transferred_initial_epoch => {}
        None => return Err(SessionStoreError::AuthorityGap),
        Some(current) if current == requested => return Ok(history),
        Some(current) => {
            let next = current.lease_epoch().next()?;
            if requested.lease_epoch().get() <= current.lease_epoch().get() {
                return Err(SessionStoreError::StaleAuthority);
            }
            if requested.lease_epoch() != next {
                return Err(SessionStoreError::AuthorityGap);
            }
        }
    }
    if history.transitions >= limits.max_authority_transitions() {
        return Err(SessionStoreError::AuthorityLimitExceeded);
    }
    append_authority(path, &mut history, requested, limits)?;
    Ok(history)
}

fn recover(
    path: &std::path::Path,
    limits: SessionStoreLimits,
) -> Result<AuthorityHistory, SessionStoreError> {
    recover_inner(path, limits, true)
}

pub fn read_history(
    path: &std::path::Path,
    limits: SessionStoreLimits,
) -> Result<AuthorityHistory, SessionStoreError> {
    validate_regular_file(path)?;
    recover_inner(path, limits, false)
}

fn recover_inner(
    path: &std::path::Path,
    limits: SessionStoreLimits,
    repair: bool,
) -> Result<AuthorityHistory, SessionStoreError> {
    let mut reader = BufReader::new(
        File::open(path)
            .map_err(|error| SessionStoreError::io("open storage authority log", error))?,
    );
    let mut history = AuthorityHistory {
        transitions: 0,
        previous_hash: ZERO_HASH,
        log_bytes: 0,
        by_epoch: HashMap::new(),
        current: None,
    };
    let mut line = Vec::with_capacity(MAX_AUTHORITY_LINE_BYTES);
    loop {
        line.clear();
        let bytes = reader
            .by_ref()
            .take((MAX_AUTHORITY_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|error| SessionStoreError::io("read storage authority log", error))?;
        if bytes == 0 {
            break;
        }
        if line.len() > MAX_AUTHORITY_LINE_BYTES {
            return Err(SessionStoreError::CorruptAuthority);
        }
        if !line.ends_with(b"\n") {
            if !repair {
                return Err(SessionStoreError::CorruptAuthority);
            }
            truncate_tail(path, history.log_bytes)?;
            break;
        }
        let record = AuthorityRecord::parse(&line)?;
        apply_record(&mut history, record, limits)?;
        history.log_bytes = history
            .log_bytes
            .checked_add(u64::try_from(bytes).map_err(|_| SessionStoreError::CorruptAuthority)?)
            .ok_or(SessionStoreError::CorruptAuthority)?;
    }
    Ok(history)
}

fn apply_record(
    history: &mut AuthorityHistory,
    record: AuthorityRecord,
    limits: SessionStoreLimits,
) -> Result<(), SessionStoreError> {
    if history.transitions >= limits.max_authority_transitions() {
        return Err(SessionStoreError::AuthorityLimitExceeded);
    }
    let expected_transition = history
        .transitions
        .checked_add(1)
        .ok_or(SessionStoreError::CorruptAuthority)?;
    if record.transition != expected_transition || record.previous_hash != history.previous_hash {
        return Err(SessionStoreError::CorruptAuthority);
    }
    if let Some(current) = history.current.as_ref()
        && record.authority.lease_epoch() != current.lease_epoch().next()?
    {
        return Err(SessionStoreError::CorruptAuthority);
    }
    if history
        .by_epoch
        .insert(
            record.authority.lease_epoch().get(),
            record.authority.clone(),
        )
        .is_some()
    {
        return Err(SessionStoreError::CorruptAuthority);
    }
    history.transitions = expected_transition;
    history.previous_hash = record.record_hash;
    history.current = Some(record.authority);
    Ok(())
}

fn append_authority(
    path: &std::path::Path,
    history: &mut AuthorityHistory,
    authority: &StorageAuthority,
    limits: SessionStoreLimits,
) -> Result<(), SessionStoreError> {
    let transition = history
        .transitions
        .checked_add(1)
        .ok_or(SessionStoreError::AuthorityGap)?;
    let record = AuthorityRecord::new(transition, authority.clone(), history.previous_hash);
    let encoded = record.encode();
    let mut file = OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|error| SessionStoreError::io("open storage authority writer", error))?;
    let actual_length = file
        .metadata()
        .map_err(|error| SessionStoreError::io("inspect storage authority writer", error))?
        .len();
    if actual_length != history.log_bytes {
        return Err(SessionStoreError::ConcurrentMutation);
    }
    file.write_all(&encoded)
        .map_err(|error| SessionStoreError::io("append storage authority", error))?;
    file.sync_all()
        .map_err(|error| SessionStoreError::io("sync storage authority", error))?;
    apply_record(history, record, limits)?;
    history.log_bytes = history
        .log_bytes
        .checked_add(u64::try_from(encoded.len()).expect("authority record length fits u64"))
        .ok_or(SessionStoreError::CorruptAuthority)?;
    Ok(())
}

fn ensure_log(path: &std::path::Path) -> Result<(), SessionStoreError> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file
            .sync_all()
            .map_err(|error| SessionStoreError::io("sync new storage authority log", error)),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            validate_regular_file(path)
        }
        Err(error) => Err(SessionStoreError::io("create storage authority log", error)),
    }
}

fn truncate_tail(path: &std::path::Path, length: u64) -> Result<(), SessionStoreError> {
    let file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|error| SessionStoreError::io("open authority tail", error))?;
    file.set_len(length)
        .map_err(|error| SessionStoreError::io("truncate authority tail", error))?;
    file.sync_all()
        .map_err(|error| SessionStoreError::io("sync authority tail", error))
}
