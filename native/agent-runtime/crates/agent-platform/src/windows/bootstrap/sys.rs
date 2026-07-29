use std::io;
use std::mem::size_of;
#[cfg(test)]
use std::os::windows::io::BorrowedHandle;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr;

use windows_sys::Win32::Foundation::{
    GENERIC_WRITE, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TYPE_PIPE,
    GetFileType, OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetStdHandle,
};
#[cfg(test)]
use windows_sys::Win32::System::Pipes::PeekNamedPipe;
use windows_sys::Win32::System::Pipes::{CreatePipe, GetNamedPipeServerProcessId};

const PIPE_BUFFER_BYTES: u32 = 64 * 1024;
const NUL_DEVICE: [u16; 4] = [b'N' as u16, b'U' as u16, b'L' as u16, 0];

#[derive(Clone, Copy)]
pub(super) enum StandardPipe {
    Input,
    Output,
}

impl StandardPipe {
    const fn identifier(self) -> u32 {
        match self {
            Self::Input => STD_INPUT_HANDLE,
            Self::Output => STD_OUTPUT_HANDLE,
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Input => "stdin",
            Self::Output => "stdout",
        }
    }
}

pub(super) fn anonymous_pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let attributes = inheritable_security_attributes()?;
    let mut read: HANDLE = ptr::null_mut();
    let mut write: HANDLE = ptr::null_mut();
    // SAFETY: both output pointers and the initialized security attributes are
    // valid for the call. Success returns two fresh ownership handles.
    if unsafe {
        CreatePipe(
            ptr::from_mut(&mut read),
            ptr::from_mut(&mut write),
            ptr::from_ref(&attributes),
            PIPE_BUFFER_BYTES,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok((own(read)?, own(write)?))
}

pub(super) fn clear_inherit(handle: &OwnedHandle) -> io::Result<()> {
    // SAFETY: the owned handle remains valid for the call.
    if unsafe { SetHandleInformation(handle.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn inheritable_null_writer() -> io::Result<OwnedHandle> {
    let attributes = inheritable_security_attributes()?;
    // SAFETY: the NUL path and security attributes remain valid for the call.
    let handle = unsafe {
        CreateFileW(
            NUL_DEVICE.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            ptr::from_ref(&attributes),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            ptr::null_mut(),
        )
    };
    own(handle)
}

pub(super) fn take_standard_pipes() -> io::Result<(OwnedHandle, OwnedHandle, u32)> {
    let input = standard_pipe(StandardPipe::Input)?;
    let output = standard_pipe(StandardPipe::Output)?;
    if input == output {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "bootstrap stdin and stdout must be distinct pipes",
        ));
    }
    let input_creator = server_process_id(input)?;
    let output_creator = server_process_id(output)?;
    if input_creator == 0 || input_creator != output_creator {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "bootstrap pipes do not prove one non-zero creator PID",
        ));
    }
    let input = take_standard_pipe(StandardPipe::Input, input)?;
    let output = take_standard_pipe(StandardPipe::Output, output)?;
    Ok((input, output, input_creator))
}

fn standard_pipe(pipe: StandardPipe) -> io::Result<HANDLE> {
    // SAFETY: GetStdHandle has no pointer preconditions.
    let source = unsafe { GetStdHandle(pipe.identifier()) };
    if source.is_null() || source == INVALID_HANDLE_VALUE {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("bootstrap {} is unavailable", pipe.label()),
        ));
    }
    // SAFETY: the standard handle is borrowed for this query.
    if unsafe { GetFileType(source) } != FILE_TYPE_PIPE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("bootstrap {} is not a pipe", pipe.label()),
        ));
    }
    Ok(source)
}

fn take_standard_pipe(pipe: StandardPipe, source: HANDLE) -> io::Result<OwnedHandle> {
    // SAFETY: bootstrap is the child's first action. Clearing the process slot
    // transfers the original inherited handle into the owner returned below.
    if unsafe { SetStdHandle(pipe.identifier(), ptr::null_mut()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    own(source)
}

fn server_process_id(pipe: HANDLE) -> io::Result<u32> {
    let mut process_id = 0;
    // SAFETY: the validated pipe handle is live and `process_id` is writable.
    if unsafe { GetNamedPipeServerProcessId(pipe, ptr::from_mut(&mut process_id)) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(process_id)
}

#[cfg(test)]
pub(super) fn pipe_bytes_available(handle: BorrowedHandle<'_>) -> io::Result<u32> {
    let mut available = 0;
    // SAFETY: the pipe handle is borrowed and `available` is writable.
    if unsafe {
        PeekNamedPipe(
            handle.as_raw_handle(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::from_mut(&mut available),
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(available)
}

fn inheritable_security_attributes() -> io::Result<SECURITY_ATTRIBUTES> {
    Ok(SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
            .map_err(|_| io::Error::other("SECURITY_ATTRIBUTES size overflow"))?,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    })
}

fn own(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: callers pass a fresh Win32 ownership handle exactly once.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}
