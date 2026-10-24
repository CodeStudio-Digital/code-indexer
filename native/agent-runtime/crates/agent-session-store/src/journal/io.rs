use super::SessionJournal;
use crate::SessionStoreError;
use std::io::Write;

impl SessionJournal {
    pub(super) fn verify_journal_length(&mut self) -> Result<(), SessionStoreError> {
        let length = self
            .file
            .metadata()
            .map_err(|error| SessionStoreError::io("inspect session journal writer", error))?
            .len();
        if length != self.state.journal_bytes {
            self.poisoned = true;
            return Err(SessionStoreError::ConcurrentMutation);
        }
        Ok(())
    }

    pub(super) fn write_record(&mut self, encoded: &[u8]) -> Result<(), SessionStoreError> {
        self.file
            .write_all(encoded)
            .map_err(|error| SessionStoreError::io("append session journal", error))?;
        self.file
            .sync_all()
            .map_err(|error| SessionStoreError::io("sync session journal", error))
    }
}
