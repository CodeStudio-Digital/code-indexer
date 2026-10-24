use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};

use crate::layout::{SessionBundleLayout, validate_regular_file};
use crate::{SessionId, SessionStoreError};

pub fn ensure_manifest(
    layout: &SessionBundleLayout,
    session_id: &SessionId,
) -> Result<(), SessionStoreError> {
    let path = layout.manifest();
    let expected = manifest_bytes(session_id);
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => write_manifest(&mut file, &expected),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            validate_regular_file(&path)?;
            let metadata = fs::metadata(&path)
                .map_err(|source| SessionStoreError::io("inspect session manifest", source))?;
            if metadata.len() != u64::try_from(expected.len()).expect("manifest length fits u64") {
                return Err(SessionStoreError::DivergentManifest);
            }
            let mut actual = Vec::with_capacity(expected.len());
            File::open(path)
                .and_then(|mut file| file.read_to_end(&mut actual))
                .map_err(|source| SessionStoreError::io("read session manifest", source))?;
            if actual != expected {
                return Err(SessionStoreError::DivergentManifest);
            }
            Ok(())
        }
        Err(error) => Err(SessionStoreError::io("create session manifest", error)),
    }
}

pub fn validate_manifest(
    layout: &SessionBundleLayout,
    session_id: &SessionId,
) -> Result<(), SessionStoreError> {
    let path = layout.manifest();
    validate_regular_file(&path)?;
    let expected = manifest_bytes(session_id);
    if fs::metadata(&path)
        .map_err(|e| SessionStoreError::io("inspect session manifest", e))?
        .len()
        != expected.len() as u64
    {
        return Err(SessionStoreError::DivergentManifest);
    }
    if fs::read(&path).map_err(|e| SessionStoreError::io("read session manifest", e))? != expected {
        return Err(SessionStoreError::DivergentManifest);
    }
    Ok(())
}

fn manifest_bytes(session_id: &SessionId) -> Vec<u8> {
    format!(
        concat!(
            "{{\"layoutVersion\":1,\"sessionId\":\"{}\",",
            "\"storageGeneration\":\"rust_fs_v1\",",
            "\"leaseEpochAuthority\":\"storage-authority.jsonl\"}}\n"
        ),
        session_id.as_str()
    )
    .into_bytes()
}

fn write_manifest(file: &mut File, bytes: &[u8]) -> Result<(), SessionStoreError> {
    file.write_all(bytes)
        .map_err(|source| SessionStoreError::io("write session manifest", source))?;
    file.sync_all()
        .map_err(|source| SessionStoreError::io("sync session manifest", source))
}
