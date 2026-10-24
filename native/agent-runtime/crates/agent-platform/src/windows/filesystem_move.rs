//! Exclusive rename with pinned parents. No check-then-overwrite fallback.
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
};

/// Atomically moves one entry without replacing an existing destination.
/// Parent handles deny rename and reparse-point modification until commit.
/// # Errors
/// Rejects root/traversal/stream paths, reparse points, missing parents, existing
/// destinations and OS errors. Does not copy or retry a failed rename.
pub fn rename_path_no_replace(root: &Path, source: &Path, destination: &Path) -> io::Result<()> {
    validate_relative(source)?;
    validate_relative(destination)?;
    let canonical_root = std::fs::canonicalize(root)?;
    let mut parents = Vec::new();
    pin_parents(&canonical_root, source, &mut parents)?;
    pin_parents(&canonical_root, destination, &mut parents)?;
    let source = open_entry(&canonical_root.join(source), true)?;
    reject_reparse(&source)?;
    let actual = super::sys::final_file_path(&source)?;
    if !super::sys::path_is_within(&canonical_root, &actual)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "move source escapes root",
        ));
    }
    super::sys::rename_no_replace(&source, &canonical_root.join(destination))
}

fn validate_relative(path: &Path) -> io::Result<()> {
    let mut count = 0;
    for component in path.components() {
        let Component::Normal(value) = component else {
            return Err(invalid_path());
        };
        let value = value.to_string_lossy();
        // Reject Win32 aliases and alternate data streams before opening any
        // handle. Canonical relative names have no device or trailing aliases.
        let stem = value
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if value.is_empty()
            || value.ends_with(['.', ' '])
            || value.contains([':', '\0'])
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(invalid_path());
        }
        count += 1;
    }
    if count == 0 || count > 128 {
        return Err(invalid_path());
    }
    Ok(())
}

fn invalid_path() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "move requires canonical relative paths",
    )
}

fn open_entry(path: &Path, source: bool) -> io::Result<File> {
    OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | if source { DELETE } else { 0 })
        .share_mode(FILE_SHARE_READ | if source { FILE_SHARE_WRITE } else { 0 })
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

fn reject_reparse(file: &File) -> io::Result<()> {
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "move refuses reparse points",
        ));
    }
    Ok(())
}

fn pin_parents(root: &Path, relative: &Path, owners: &mut Vec<File>) -> io::Result<()> {
    let mut current = PathBuf::from(root);
    let parent = relative.parent().ok_or_else(invalid_path)?;
    for component in std::iter::once(None).chain(parent.components().map(Some)) {
        if let Some(component) = component {
            current.push(component);
        }
        let file = open_entry(&current, false)?;
        reject_reparse(&file)?;
        if !file.metadata()?.is_dir()
            || !super::sys::path_is_within(root, &super::sys::final_file_path(&file)?)?
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "move parent escapes root",
            ));
        }
        owners.push(file);
    }
    Ok(())
}
