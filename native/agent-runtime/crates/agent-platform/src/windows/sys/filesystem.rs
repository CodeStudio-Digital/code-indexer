use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};

use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_NAME_NORMALIZED, GetFinalPathNameByHandleW, VOLUME_NAME_DOS,
};

const MAX_FINAL_PATH_UNITS: usize = 32_768;

pub(in crate::windows) fn final_file_path(file: &File) -> io::Result<PathBuf> {
    let mut buffer = vec![0_u16; MAX_FINAL_PATH_UNITS];
    // SAFETY: the File owns a valid readable handle and buffer is writable for
    // its advertised u16 capacity throughout the call.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle().cast(),
            buffer.as_mut_ptr(),
            u32::try_from(buffer.len())
                .map_err(|_| io::Error::other("final path buffer overflow"))?,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    let length = usize::try_from(length).map_err(|_| io::Error::other("final path overflow"))?;
    if length >= buffer.len() {
        return Err(io::Error::other("final path exceeds bounded buffer"));
    }
    buffer.truncate(length);
    Ok(PathBuf::from(OsString::from_wide(&buffer)))
}

pub(in crate::windows) fn path_is_within(root: &Path, target: &Path) -> io::Result<bool> {
    let root = trimmed_wide(root);
    let target = trimmed_wide(target);
    if target.len() < root.len() || !equal_ordinal(&root, &target[..root.len()])? {
        return Ok(false);
    }
    Ok(target.len() == root.len()
        || target
            .get(root.len())
            .is_some_and(|unit| *unit == u16::from(b'\\') || *unit == u16::from(b'/')))
}

fn trimmed_wide(path: &Path) -> Vec<u16> {
    let mut value = path.as_os_str().encode_wide().collect::<Vec<_>>();
    while value
        .last()
        .is_some_and(|unit| *unit == u16::from(b'\\') || *unit == u16::from(b'/'))
    {
        value.pop();
    }
    value
}

fn equal_ordinal(left: &[u16], right: &[u16]) -> io::Result<bool> {
    let left_len = i32::try_from(left.len()).map_err(|_| io::Error::other("path overflow"))?;
    let right_len = i32::try_from(right.len()).map_err(|_| io::Error::other("path overflow"))?;
    // SAFETY: both slices remain valid for their explicit lengths and the API
    // performs a locale-independent, case-insensitive ordinal comparison.
    let result =
        unsafe { CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, 1) };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result == CSTR_EQUAL)
    }
}
