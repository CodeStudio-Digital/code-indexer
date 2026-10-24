use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr;
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Console::{COORD, ClosePseudoConsole, CreatePseudoConsole};
use windows_sys::Win32::System::Pipes::CreatePipe;

pub(super) fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let mut read: HANDLE = ptr::null_mut();
    let mut write: HANDLE = ptr::null_mut();
    // SAFETY: valid output pointers. Null security attributes make both ends
    // non-inheritable; the console is installed by an explicit startup attribute.
    if unsafe { CreatePipe(&raw mut read, &raw mut write, ptr::null(), 64 * 1024) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((own(read)?, own(write)?))
}

fn own(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a successful OS creation transferred this distinct handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

pub(super) fn create(
    columns: u16,
    rows: u16,
    input: &OwnedHandle,
    output: &OwnedHandle,
) -> io::Result<isize> {
    let size = COORD {
        X: i16::try_from(columns).map_err(io::Error::other)?,
        Y: i16::try_from(rows).map_err(io::Error::other)?,
    };
    let mut console = 0_isize;
    // SAFETY: size is validated, endpoints remain owned during the call, and
    // console is a writable HPCON. No inherited cursor query is requested.
    let status = unsafe {
        CreatePseudoConsole(
            size,
            input.as_raw_handle(),
            output.as_raw_handle(),
            0,
            &raw mut console,
        )
    };
    if status < 0 {
        return Err(io::Error::other(format!(
            "CreatePseudoConsole HRESULT {status:#x}"
        )));
    }
    Ok(console)
}

pub(super) fn close(console: isize) {
    // SAFETY: ConsoleOwner is the unique final Arc owner of this live HPCON.
    // Its caller drains output on a separate thread or already closed the pipe.
    unsafe {
        ClosePseudoConsole(console);
    }
}
