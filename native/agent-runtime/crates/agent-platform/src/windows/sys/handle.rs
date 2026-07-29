use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

use windows_sys::Win32::Foundation::HANDLE;

use super::super::WindowsContainmentError;

pub(super) fn own_handle(
    handle: HANDLE,
    operation: &'static str,
) -> Result<OwnedHandle, WindowsContainmentError> {
    if handle.is_null() {
        return Err(WindowsContainmentError::last_os_error(operation));
    }
    // SAFETY: callers pass a fresh Win32 ownership handle exactly once.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

pub(super) fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle()
}
