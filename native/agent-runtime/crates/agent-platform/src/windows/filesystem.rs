use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Component, Path};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedFileRead {
    pub content: Vec<u8>,
    pub bytes_read: u64,
    pub truncated: bool,
    pub eof: bool,
}

/// Opens a relative file, proves its final handle path remains inside the
/// canonical root, and reads at most `limit` result bytes plus one probe byte.
///
/// # Errors
///
/// Rejects non-canonical relative paths, root escapes, non-files and I/O
/// failures. No content is returned before the final handle path is proven.
pub fn read_file_within_root(
    root: &Path,
    relative: &Path,
    offset: u64,
    limit: usize,
) -> io::Result<BoundedFileRead> {
    if limit == 0 || !canonical_relative_path(relative) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "native read requires a canonical relative path and nonzero limit",
        ));
    }
    let canonical_root = std::fs::canonicalize(root)?;
    let mut file = File::open(canonical_root.join(relative))?;
    let final_path = super::sys::final_file_path(&file)?;
    if !super::sys::path_is_within(&canonical_root, &final_path)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "final file handle escapes the granted root",
        ));
    }
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "native read target is not a regular file",
        ));
    }
    file.seek(SeekFrom::Start(offset))?;
    let probe_limit = limit
        .checked_add(1)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "read limit overflow"))?;
    let mut content = Vec::with_capacity(probe_limit);
    file.take(u64::try_from(probe_limit).unwrap_or(u64::MAX))
        .read_to_end(&mut content)?;
    let bytes_read = u64::try_from(content.len()).unwrap_or(u64::MAX);
    let truncated = content.len() > limit;
    if truncated {
        content.truncate(limit);
    }
    Ok(BoundedFileRead {
        content,
        bytes_read,
        truncated,
        eof: !truncated,
    })
}

fn canonical_relative_path(path: &Path) -> bool {
    let mut count = 0_usize;
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return false;
        }
        count = count.saturating_add(1);
    }
    count > 0
}
