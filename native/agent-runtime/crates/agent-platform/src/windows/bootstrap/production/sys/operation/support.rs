use std::fmt::{self, Debug, Formatter};
use std::io;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::ptr;

use windows_sys::Win32::Foundation::{
    ERROR_BROKEN_PIPE, ERROR_PIPE_NOT_CONNECTED, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::System::Threading::CreateEventW;

use super::RawOverlappedOperation;

impl Debug for RawOverlappedOperation {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RawOverlappedOperation")
            .field("pending", &self.pending)
            .field(
                "buffer_length",
                &self
                    .buffer
                    .as_ref()
                    .map_or(0, |buffer| buffer.bytes().len()),
            )
            .finish_non_exhaustive()
    }
}

pub(super) fn create_event() -> io::Result<OwnedHandle> {
    // SAFETY: unnamed event creation has no borrowed pointer lifetime.
    let event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
    if event.is_null() || event == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful CreateEventW returns one fresh ownership handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(event) })
}

pub(super) fn is_pipe_eof(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error().map(i32::cast_unsigned),
        Some(ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED)
    )
}
