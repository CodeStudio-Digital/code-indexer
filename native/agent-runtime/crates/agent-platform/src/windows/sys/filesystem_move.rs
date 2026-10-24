use std::fs::File;
use std::io;
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_RENAME_INFO, FileRenameInfo, SetFileInformationByHandle,
};

pub(in crate::windows) fn rename_no_replace(file: &File, destination: &Path) -> io::Result<()> {
    let name = destination.as_os_str().encode_wide().collect::<Vec<_>>();
    if name.is_empty() || name.len() >= 32_768 || name.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid move destination",
        ));
    }
    let name_bytes = name.len() * size_of::<u16>();
    let length = (offset_of!(FILE_RENAME_INFO, FileName) + name_bytes + size_of::<u16>())
        .max(size_of::<FILE_RENAME_INFO>());
    // u64 storage provides the alignment required by FILE_RENAME_INFO on all
    // supported Windows targets; include the optional terminating NUL.
    let mut storage = vec![0_u64; length.div_ceil(size_of::<u64>())];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: storage is aligned, zero-initialized and large enough for both
    // the fixed header and UTF-16 name. Both allocations live across the call.
    let result = unsafe {
        (*info).Anonymous.ReplaceIfExists = false;
        (*info).RootDirectory = std::ptr::null_mut();
        (*info).FileNameLength =
            u32::try_from(name_bytes).map_err(|_| io::Error::other("name overflow"))?;
        std::ptr::copy_nonoverlapping(name.as_ptr(), (*info).FileName.as_mut_ptr(), name.len());
        SetFileInformationByHandle(
            file.as_raw_handle().cast(),
            FileRenameInfo,
            info.cast(),
            u32::try_from(length).map_err(|_| io::Error::other("rename buffer overflow"))?,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
