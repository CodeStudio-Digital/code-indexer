use std::io;
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::ptr;

use windows_sys::Win32::Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

#[derive(Debug)]
pub(super) struct PreparedChildHandle {
    source: usize,
    owned: OwnedHandle,
}

impl PreparedChildHandle {
    pub(super) fn duplicate(source: BorrowedHandle<'_>) -> io::Result<Self> {
        let process = unsafe { GetCurrentProcess() };
        let mut duplicate: HANDLE = ptr::null_mut();
        let source_raw = source.as_raw_handle();
        // SAFETY: both process pseudo-handles are valid for this process, the
        // source is borrowed for the call and `duplicate` is writable.
        if unsafe {
            DuplicateHandle(
                process,
                source_raw,
                process,
                ptr::from_mut(&mut duplicate),
                0,
                1,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful DuplicateHandle returns one new ownership handle.
        let owned = unsafe { OwnedHandle::from_raw_handle(duplicate) };
        Ok(Self {
            source: source_raw as usize,
            owned,
        })
    }

    pub(super) const fn source(&self) -> usize {
        self.source
    }

    pub(super) fn raw(&self) -> HANDLE {
        self.owned.as_raw_handle()
    }

    #[cfg(test)]
    pub(super) fn raw_value(&self) -> usize {
        self.raw() as usize
    }
}
