use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr;

use windows_sys::Win32::Foundation::{
    ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, ReadFile,
    WriteFile,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeServerProcessId, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};

use super::super::WindowsContainmentError;

pub(in crate::windows) fn create_test_pipe(
    address: &str,
) -> Result<OwnedHandle, WindowsContainmentError> {
    let encoded = wide(address);
    let open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE;
    let pipe_mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
    // SAFETY: the encoded path is NUL-terminated and all optional pointers are
    // null. The returned ownership handle is wrapped exactly once.
    let handle = unsafe {
        CreateNamedPipeW(
            encoded.as_ptr(),
            open_mode,
            pipe_mode,
            1,
            1024,
            1024,
            0,
            ptr::null(),
        )
    };
    own_file_handle(handle, "CreateNamedPipeW(PID probe)")
}

pub(in crate::windows) fn open_test_pipe_client(
    address: &str,
) -> Result<OwnedHandle, WindowsContainmentError> {
    let encoded = wide(address);
    // SAFETY: the path is NUL-terminated and no security/template pointer is
    // retained. A successful ownership handle is wrapped exactly once.
    let handle = unsafe {
        CreateFileW(
            encoded.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            ptr::null(),
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        )
    };
    own_file_handle(handle, "CreateFileW(PID probe)")
}

pub(in crate::windows) fn connect_and_wait_for_byte(
    handle_value: usize,
) -> Result<(), WindowsContainmentError> {
    let handle = handle_value as HANDLE;
    // SAFETY: the test parent transfers this exact server handle through the
    // process HANDLE_LIST. A raced client is the documented connected case.
    if unsafe { ConnectNamedPipe(handle, ptr::null_mut()) } == 0 {
        let source = io::Error::last_os_error();
        if source.raw_os_error() != Some(ERROR_PIPE_CONNECTED.cast_signed()) {
            return Err(WindowsContainmentError::Os {
                operation: "ConnectNamedPipe(PID probe)",
                source,
            });
        }
    }
    let mut byte = 0_u8;
    let mut read = 0_u32;
    // SAFETY: the inherited handle stays live and both output buffers are
    // writable for this synchronous one-byte read.
    if unsafe {
        ReadFile(
            handle,
            ptr::from_mut(&mut byte).cast(),
            1,
            ptr::from_mut(&mut read),
            ptr::null_mut(),
        )
    } == 0
        || read != 1
    {
        return Err(WindowsContainmentError::last_os_error(
            "ReadFile(PID probe)",
        ));
    }
    Ok(())
}

pub(in crate::windows) fn server_process_id(
    client: &OwnedHandle,
) -> Result<u32, WindowsContainmentError> {
    let mut process_id = 0;
    // SAFETY: the connected client handle remains live and the output pointer
    // is writable for the call.
    if unsafe {
        GetNamedPipeServerProcessId(client.as_raw_handle(), ptr::from_mut(&mut process_id))
    } == 0
    {
        return Err(WindowsContainmentError::last_os_error(
            "GetNamedPipeServerProcessId(PID probe)",
        ));
    }
    Ok(process_id)
}

pub(in crate::windows) fn write_release_byte(
    client: &OwnedHandle,
) -> Result<(), WindowsContainmentError> {
    let byte = 1_u8;
    let mut written = 0_u32;
    // SAFETY: the connected client remains live and the byte/count pointers
    // are valid for this synchronous write.
    if unsafe {
        WriteFile(
            client.as_raw_handle(),
            ptr::from_ref(&byte).cast(),
            1,
            ptr::from_mut(&mut written),
            ptr::null_mut(),
        )
    } == 0
        || written != 1
    {
        return Err(WindowsContainmentError::last_os_error(
            "WriteFile(PID probe)",
        ));
    }
    Ok(())
}

fn own_file_handle(
    handle: HANDLE,
    operation: &'static str,
) -> Result<OwnedHandle, WindowsContainmentError> {
    if handle == INVALID_HANDLE_VALUE {
        return Err(WindowsContainmentError::last_os_error(operation));
    }
    // SAFETY: callers pass one fresh ownership handle exactly once.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}
