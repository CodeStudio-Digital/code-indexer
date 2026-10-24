//! Durable physical evidence. Reopening never replays a launch or a management
//! frame: a Host must reconcile the original connection and attempt authority.
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use agent_protocol::generated::v1 as wire;
use prost::Message;
use sha2::{Digest, Sha256};

mod open;

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 64 * 1024;
const MAX_RECORDS: usize = 8192;

#[derive(Debug)]
pub struct DurableLifecycleOutbox {
    file: File,
    directory: PathBuf,
    connection: String,
    tail: [u8; 32],
    records: usize,
    entries: BTreeMap<String, wire::SupervisorLifecycleOutboxEntryV1>,
    poisoned: bool,
}

impl DurableLifecycleOutbox {
    /// Opens an exclusively owned, bounded log. Incomplete or corrupt tails
    /// require reconciliation; they are never silently truncated.
    /// # Errors
    /// Rejects unsafe paths, busy ownership, corrupt records and I/O failures.
    pub fn open(directory: &Path, connection: &str) -> io::Result<Self> {
        Self::open_internal(directory, connection, true)
    }

    /// Acquires the original process lock before inspecting existing evidence.
    /// It never creates a file or changes the acknowledged state.
    /// # Errors
    /// Rejects live ownership, absent or corrupt evidence and I/O failures.
    pub fn inspect(
        directory: &Path,
        connection: &str,
        attempt: &str,
    ) -> io::Result<Option<wire::SupervisorLifecycleOutboxEntryV1>> {
        Ok(Self::open_internal(directory, connection, false)?
            .entries
            .get(attempt)
            .cloned())
    }

    #[must_use]
    pub fn connection_id(&self) -> &str {
        &self.connection
    }

    #[must_use]
    pub fn pending(&self) -> Vec<wire::SupervisorLifecycleOutboxEntryV1> {
        self.entries
            .values()
            .filter(|entry| !entry.host_acknowledged)
            .cloned()
            .collect()
    }

    /// # Errors
    /// Rejects divergent evidence, exhausted limits or failed durable writes.
    pub fn stage(&mut self, entry: wire::SupervisorLifecycleOutboxEntryV1) -> io::Result<()> {
        if entry.host_acknowledged {
            return Err(invalid("new evidence cannot acknowledge itself"));
        }
        if self.entries.get(attempt_id(&entry)?) == Some(&entry) {
            return Ok(());
        }
        self.append(entry)
    }

    /// # Errors
    /// Rejects unknown attempts or failed durable writes.
    pub fn acknowledge(&mut self, attempt: &str) -> io::Result<()> {
        let mut entry = self
            .entries
            .get(attempt)
            .cloned()
            .ok_or_else(|| invalid("outbox ACK has no physical evidence"))?;
        if entry.host_acknowledged {
            return Ok(());
        }
        entry.host_acknowledged = true;
        self.append(entry)
    }

    fn validate_transition(
        &self,
        entry: &wire::SupervisorLifecycleOutboxEntryV1,
    ) -> io::Result<()> {
        let id = attempt_id(entry)?;
        let exited = entry.exited.as_ref().expect("checked");
        let reaped = entry
            .reaped
            .as_ref()
            .ok_or_else(|| invalid("outbox has no Reaped evidence"))?;
        if entry.schema_version != 1
            || entry.connection_id != self.connection
            || exited.identity != reaped.identity
            || exited.exited_at_unix_ms <= 0
            || reaped.reaped_at_unix_ms < exited.exited_at_unix_ms
            || exited.runner_provenance.as_ref().is_none_or(|provenance| {
                provenance.pid == 0
                    || provenance.runtime_instance_id != reaped.runtime_instance_id
                    || provenance.binary_sha256.len() != 32
            })
            || reaped.resource_group_id.is_empty()
            || reaped.released_resources.is_empty()
        {
            return Err(invalid("outbox evidence authority diverged"));
        }
        match self.entries.get(id) {
            None if !entry.host_acknowledged => Ok(()),
            Some(previous) if !previous.host_acknowledged && entry.host_acknowledged => {
                let mut expected = previous.clone();
                expected.host_acknowledged = true;
                if &expected == entry {
                    Ok(())
                } else {
                    Err(invalid("outbox ACK changed evidence"))
                }
            }
            _ => Err(invalid("outbox phase repeated or changed")),
        }
    }

    fn append(&mut self, entry: wire::SupervisorLifecycleOutboxEntryV1) -> io::Result<()> {
        if self.poisoned || self.directory.canonicalize()? != self.directory {
            return Err(invalid("outbox owner is unavailable"));
        }
        self.validate_transition(&entry)?;
        let payload = entry.encode_to_vec();
        if payload.len() > MAX_RECORD_BYTES
            || self.records >= MAX_RECORDS
            || self.file.metadata()?.len() + 36 + payload.len() as u64 > MAX_FILE_BYTES
        {
            return Err(invalid("outbox capacity exceeded"));
        }
        let digest = digest(self.tail, &payload);
        self.poisoned = true;
        let length =
            u32::try_from(payload.len()).map_err(|_| invalid("outbox record too large"))?;
        self.file.write_all(&length.to_le_bytes())?;
        self.file.write_all(&digest)?;
        self.file.write_all(&payload)?;
        self.file.sync_all()?;
        self.entries.insert(attempt_id(&entry)?.to_owned(), entry);
        self.tail = digest;
        self.records += 1;
        self.poisoned = false;
        Ok(())
    }
}

fn attempt_id(entry: &wire::SupervisorLifecycleOutboxEntryV1) -> io::Result<&str> {
    let id = entry
        .exited
        .as_ref()
        .and_then(|value| value.identity.as_ref())
        .map(|identity| identity.attempt_id.as_str())
        .ok_or_else(|| invalid("outbox attempt absent"))?;
    if id.is_empty() || id.len() > 512 {
        return Err(invalid("outbox attempt invalid"));
    }
    Ok(id)
}
fn digest(previous: [u8; 32], payload: &[u8]) -> [u8; 32] {
    Sha256::new()
        .chain_update(previous)
        .chain_update(payload)
        .finalize()
        .into()
}
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests;
