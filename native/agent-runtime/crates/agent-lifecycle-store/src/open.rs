use super::{
    DurableLifecycleOutbox, MAX_FILE_BYTES, MAX_RECORD_BYTES, MAX_RECORDS, attempt_id, digest,
    invalid,
};
use agent_protocol::generated::v1 as wire;
use prost::Message;
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

impl DurableLifecycleOutbox {
    pub(super) fn open_internal(
        directory: &Path,
        connection: &str,
        create: bool,
    ) -> io::Result<Self> {
        if !directory.is_absolute() || connection.is_empty() || connection.len() > 512 {
            return Err(invalid("outbox authority is invalid"));
        }
        let directory = directory.canonicalize()?;
        if !directory.is_dir() {
            return Err(invalid("outbox root is not a directory"));
        }
        let path = directory.join("lifecycle.wal");
        if let Ok(metadata) = path.symlink_metadata()
            && (!metadata.is_file() || metadata.file_type().is_symlink())
        {
            return Err(invalid("outbox is not a regular file"));
        }
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(create)
            .truncate(false)
            .open(path)?;
        file.try_lock().map_err(|error| match error {
            std::fs::TryLockError::WouldBlock => io::Error::from(io::ErrorKind::WouldBlock),
            std::fs::TryLockError::Error(error) => error,
        })?;
        if file.metadata()?.len() > MAX_FILE_BYTES {
            return Err(invalid("outbox file bound exceeded"));
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(invalid("outbox file bound exceeded"));
        }
        let mut outbox = Self {
            file,
            directory,
            connection: connection.to_owned(),
            tail: [0; 32],
            records: 0,
            entries: BTreeMap::new(),
            poisoned: false,
        };
        let mut offset = 0;
        while offset < bytes.len() {
            let header = bytes
                .get(offset..offset + 36)
                .ok_or_else(|| invalid("outbox partial header"))?;
            let length = u32::from_le_bytes(header[..4].try_into().expect("four bytes")) as usize;
            if length == 0 || length > MAX_RECORD_BYTES || outbox.records >= MAX_RECORDS {
                return Err(invalid("outbox record bound exceeded"));
            }
            let payload = bytes
                .get(offset + 36..offset + 36 + length)
                .ok_or_else(|| invalid("outbox partial payload"))?;
            let digest = digest(outbox.tail, payload);
            if digest.as_slice() != &header[4..] {
                return Err(invalid("outbox digest mismatch"));
            }
            let entry = wire::SupervisorLifecycleOutboxEntryV1::decode(payload)
                .map_err(io::Error::other)?;
            if entry.encode_to_vec() != payload {
                return Err(invalid("outbox noncanonical record"));
            }
            outbox.validate_transition(&entry)?;
            outbox.entries.insert(attempt_id(&entry)?.to_owned(), entry);
            outbox.tail = digest;
            outbox.records += 1;
            offset += 36 + length;
        }
        outbox.file.seek(SeekFrom::End(0))?;
        Ok(outbox)
    }
}
